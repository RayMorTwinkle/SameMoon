import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { RoomManager } from './room/RoomManager.js';
import type { WsMessage } from './ws/protocol.js';

// ─── 安全加固常量（TECH-SPEC §6） ───────────────────────
const MAX_MSG_SIZE = 4096;           // 单条消息 ≤4KB
const RATE_WINDOW_MS = 10_000;      // 频率窗口 10s
const RATE_MAX_MSGS = 30;           // 每窗口最多 30 条
const HELLO_TIMEOUT_MS = 10_000;    // 未 hello 断开
const CHAT_MAX_LENGTH = 500;        // 聊天 ≤500 字符
const JOIN_MAX_PER_MINUTE = 20;     // 每 IP 每分钟最多 20 次 join
const ROOM_CODE_REGEX = /^\d{4}$/;  // 房间号必须是4位数字

// 转发白名单（TECH-SPEC §6）
const FORWARD_WHITELIST = new Set([
  'sync:play', 'sync:pause', 'sync:seek', 'sync:rate',
  'sync:heartbeat', 'sync:state', 'sync:buffering', 'sync:ready',
  'player:ready', 'chat:message',
  // Phase 2+ 预留
  'rtc:offer', 'rtc:answer', 'rtc:ice',
  'source:set', 'browse:navigate',
]);

/** 构建 Fastify 应用（导出以便测试） */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const roomManager = new RoomManager();

  // 每 IP join 计数器（简单内存实现，仅用于防暴力枚举）
  const joinCounters = new Map<string, { count: number; resetAt: number }>();

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // 健康检查
  app.get('/health', async () => {
    return { status: 'ok', rooms: roomManager.activeRoomCount };
  });

  // 断线超时回调：真正移除用户并通知房间内其他人
  roomManager.onDisconnectExpired = (sessionId, roomCode) => {
    const room = roomManager.getRoom(roomCode);
    if (!room) return;
    const user = room.users.get(sessionId);
    if (!user || user.ws !== null) return; // 已重连，不处理

    roomManager.broadcast(roomCode, {
      type: 'room:left',
      room: roomCode,
      data: { userId: sessionId },
    }, sessionId);
    roomManager.forceRemove(roomCode, sessionId);
  };

  // WebSocket 信令入口
  app.get('/ws', { websocket: true }, (socket, req) => {
    let sessionId: string | null = null;
    let currentRoom: string | null = null;
    let helloReceived = false;

    // 频率限制：滑动窗口
    const msgTimestamps: number[] = [];
    const checkRateLimit = (): boolean => {
      const now = Date.now();
      // 清理窗口外的记录
      while (msgTimestamps.length > 0 && now - msgTimestamps[0] > RATE_WINDOW_MS) {
        msgTimestamps.shift();
      }
      msgTimestamps.push(now);
      return msgTimestamps.length <= RATE_MAX_MSGS;
    };

    // 未 hello 超时断开
    const helloTimeout = setTimeout(() => {
      if (!helloReceived) {
        socket.close(1002, '未在规定时间内完成身份验证');
      }
    }, HELLO_TIMEOUT_MS);

    socket.on('message', (raw: Buffer) => {
      // 消息大小校验（§6）
      if (raw.byteLength > MAX_MSG_SIZE) {
        socket.send(JSON.stringify({
          type: 'error',
          data: { code: 'INVALID_SIZE', message: '消息大小超过 4KB 限制' },
        }));
        return;
      }

      // 频率限制（§6）
      if (!checkRateLimit()) {
        socket.close(1008, '消息频率过高');
        return;
      }

      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({
          type: 'error',
          data: { code: 'INVALID_JSON', message: '消息格式无效' },
        }));
        return;
      }

      // JSON 必须为 object，type 必须是 string（§6）
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)
          || typeof msg.type !== 'string') {
        socket.send(JSON.stringify({
          type: 'error',
          data: { code: 'INVALID_JSON', message: '消息必须是 object 且 type 为 string' },
        }));
        return;
      }

      // 未 hello 前只接受 session:hello（§6）
      if (!helloReceived && msg.type !== 'session:hello') {
        socket.send(JSON.stringify({
          type: 'error',
          data: { code: 'AUTH_REQUIRED', message: '请先发送 session:hello' },
        }));
        return;
      }

      switch (msg.type) {
        case 'session:hello': {
          const sid = (msg.data as { sessionId?: string } | undefined)?.sessionId;
          if (!sid || typeof sid !== 'string' || sid.length < 1) {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'INVALID_SESSION', message: 'sessionId 无效' },
            }));
            return;
          }

          helloReceived = true;
          clearTimeout(helloTimeout);
          sessionId = sid;

          // 检查是否有断线中的房间（重连）
          const existingEntry = roomManager.findUserRoom(sid);
          if (existingEntry) {
            const { roomCode: code, room } = existingEntry;
            const user = room.users.get(sid)!;

            // Fix: 重连后清除旧 fileInfo，因为 objectURL 已失效
            // 保留副本用于通知客户端之前选了什么文件
            const prevFileInfo = user.fileInfo;
            user.fileInfo = undefined;
            // 如果之前在 playing 状态，退回到 selecting（需要重新选文件验证）
            if (room.state === 'playing') {
              room.state = 'selecting';
            }

            const reconnected = roomManager.reconnectUser(code, sid, socket);
            if (reconnected) {
              currentRoom = code;
              const peerOnline = roomManager.getPeerOnline(code, sid);

              // 通知 peer: 断线用户重连，需要重新验证文件
              if (peerOnline) {
                roomManager.broadcast(code, {
                  type: 'file:reset',
                  room: code,
                  data: { userId: sid },
                }, sid);
              }

              socket.send(JSON.stringify({
                type: 'session:restored',
                data: {
                  sessionId: sid,
                  roomCode: code,
                  role: user.role,
                  roomState: room.state,
                  peerOnline,
                  fileName: prevFileInfo?.name,
                  fileSize: prevFileInfo?.size,
                },
              }));

              // 通知房间内其他人
              roomManager.broadcast(code, {
                type: 'room:peer-joined',
                room: code,
                data: { userId: sid },
              }, sid);

              return;
            }
          }

          // 新会话
          socket.send(JSON.stringify({
            type: 'connected',
            data: { userId: sid },
          }));
          break;
        }

        case 'room:create': {
          // 防重：已在房间内则不允许再创建
          if (currentRoom) {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'ALREADY_IN_ROOM', message: '你已在房间中' },
            }));
            break;
          }
          let room;
          try {
            room = roomManager.createRoom(sessionId!, socket);
          } catch {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'SERVER_FULL', message: '服务器房间已满，请稍后再试' },
            }));
            break;
          }
          currentRoom = room.code;
          socket.send(JSON.stringify({
            type: 'room:created',
            room: room.code,
            data: { roomCode: room.code, role: 'host' },
          }));
          break;
        }

        case 'room:join': {
          const code = (msg.data as { roomCode: string }).roomCode;

          // roomCode 正则校验（§6）
          if (!ROOM_CODE_REGEX.test(code)) {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'INVALID_ROOM', message: '房间号格式无效' },
            }));
            break;
          }

          const existing = roomManager.getRoom(code);
          const alreadyIn = existing?.users.has(sessionId!) ?? false;

          // join 频率限制（§6）：基于 IP
          const ip = req.socket.remoteAddress ?? 'unknown';
          const now = Date.now();
          const counter = joinCounters.get(ip);
          if (counter && now < counter.resetAt) {
            counter.count += 1;
            if (counter.count > JOIN_MAX_PER_MINUTE) {
              socket.send(JSON.stringify({
                type: 'error',
                data: { code: 'RATE_LIMITED', message: '操作太频繁，请稍后再试' },
              }));
              break;
            }
          } else {
            joinCounters.set(ip, { count: 1, resetAt: now + 60_000 });
          }

          const room = roomManager.joinRoom(code, sessionId!, socket);
          if (!room) {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'ROOM_NOT_FOUND', message: '房间不存在或已满' },
            }));
            break;
          }
          currentRoom = code;

          // 如果是重连（之前在此房间中），清除断线定时器
          roomManager.clearDisconnectTimer(sessionId!);

          const me = room.users.get(sessionId!)!;
          // 回复加入者（幂等：重复 join 返回当前实际角色，不产生副作用）
          socket.send(JSON.stringify({
            type: 'room:joined',
            room: code,
            data: {
              userId: sessionId,
              role: me.role,
              peerCount: room.users.size - 1,
              rejoin: alreadyIn,
            },
          }));

          // 仅首次加入才广播给房间内其他人
          if (!alreadyIn) {
            roomManager.broadcast(code, {
              type: 'room:peer-joined',
              room: code,
              data: { userId: sessionId },
            }, sessionId!);
          }
          break;
        }

        case 'file:info': {
          if (!currentRoom) break;
          const room = roomManager.getRoom(currentRoom);
          if (!room) break;

          const user = room.users.get(sessionId!);
          if (user) {
            user.fileInfo = msg.data as { name: string; size: number };
          }

          // 双方文件都提交后进行验证
          const users = [...room.users.values()];
          if (users.length === 2 && users.every(u => u.fileInfo)) {
            const [a, b] = users;
            const matched = a.fileInfo!.name === b.fileInfo!.name
              && a.fileInfo!.size === b.fileInfo!.size;

            const diff = !matched
              ? `文件名: "${a.fileInfo!.name}" vs "${b.fileInfo!.name}", 大小: ${a.fileInfo!.size} vs ${b.fileInfo!.size}`
              : undefined;

            roomManager.broadcast(currentRoom, {
              type: 'file:match',
              room: currentRoom,
              data: { matched, diff },
            });

            if (matched) {
              room.state = 'playing';
            }
          }
          break;
        }

        // 同步/聊天消息：白名单校验后转发给对方（P2P 建立前由服务器中转）
        default: {
          // 聊天长度限制（§6）
          if (msg.type === 'chat:message') {
            const text = (msg.data as { text?: string } | undefined)?.text;
            if (typeof text === 'string' && text.length > CHAT_MAX_LENGTH) {
              (msg.data as { text: string }).text = text.slice(0, CHAT_MAX_LENGTH);
            }
          }

          // 白名单校验（§6）
          if (FORWARD_WHITELIST.has(msg.type)) {
            if (!currentRoom) break;
            roomManager.broadcast(currentRoom, {
              ...msg,
              from: sessionId,
              room: currentRoom,
            }, sessionId!);
          } else {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'UNKNOWN_TYPE', message: `未知消息类型: ${msg.type}` },
            }));
          }
          break;
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimeout);
      if (currentRoom && sessionId) {
        // 标记离线并启动断线倒计时
        roomManager.markOffline(currentRoom, sessionId);
        roomManager.broadcast(currentRoom, {
          type: 'room:left',
          room: currentRoom,
          data: { userId: sessionId },
        }, sessionId);
        roomManager.startDisconnectTimer(sessionId, currentRoom);
      }
    });
  });

  return app;
}
