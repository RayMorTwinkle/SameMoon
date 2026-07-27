import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { RoomManager } from './room/RoomManager.js';
import type { WsMessage, RoomMode } from './ws/protocol.js';

// ─── 安全加固常量（TECH-SPEC §6） ───────────────────────
const MAX_MSG_SIZE = 4096;           // 单条消息 ≤4KB
const RATE_WINDOW_MS = 10_000;      // 频率窗口 10s
const RATE_MAX_MSGS = 30;           // 每窗口最多 30 条
const HELLO_TIMEOUT_MS = 10_000;    // 未 hello 断开
const CHAT_MAX_LENGTH = 500;        // 聊天 ≤500 字符
const JOIN_MAX_PER_MINUTE = 20;     // 每 IP 每分钟最多 20 次 join
const ROOM_CODE_REGEX = /^\d{4}$/;  // 房间号必须是4位数字

// ─── Cloudflare TURN（Stage 2） ─────────────────────────
const TURN_KEY_ID = process.env.TURN_KEY_ID;
const TURN_API_TOKEN = process.env.TURN_API_TOKEN;
const TURN_CREDENTIAL_TTL = 86_400;        // Cloudflare 凭据有效期 24h
const TURN_CACHE_TTL = TURN_CREDENTIAL_TTL - 3_600; // 提前 1h 刷新缓存

let cachedIceServers: { iceServers: unknown; } | null = null;
let cacheExpiresAt = 0;

// 转发白名单（TECH-SPEC §6 + Stage 2 扩展）
const FORWARD_WHITELIST = new Set([
  'sync:play', 'sync:pause', 'sync:seek', 'sync:rate',
  'sync:heartbeat', 'sync:state', 'sync:buffering', 'sync:ready',
  'player:ready', 'chat:message',
  // WebRTC 信令
  'rtc:offer', 'rtc:answer', 'rtc:ice',
  // 文件传输协调
  'file:offer', 'file:accept', 'file:progress', 'file:complete', 'file:cancelled',
  // 屏幕分享协调
  'screen:request', 'screen:grant', 'screen:busy', 'screen:stop',
  // Phase 3+ 预留
  'source:set', 'browse:navigate',
]);

// 不需要 room 的消息类型（可在未加入房间时使用）
const NO_ROOM_TYPES = new Set([
  'rtc:offer', 'rtc:answer', 'rtc:ice',
  'file:offer', 'file:accept', 'file:progress', 'file:complete', 'file:cancelled',
  'ping',
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

  // ─── Cloudflare TURN 凭据端点（Stage 2） ─────────────
  app.get('/api/ice-servers', async (_req, reply) => {
    // 缓存命中
    if (cachedIceServers && Date.now() < cacheExpiresAt) {
      return cachedIceServers;
    }

    // 无凭据配置 → 仅返回公共 STUN
    if (!TURN_KEY_ID || !TURN_API_TOKEN) {
      const fallback = {
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
        ],
      };
      cachedIceServers = fallback;
      cacheExpiresAt = Date.now() + TURN_CACHE_TTL * 1000;
      return fallback;
    }

    try {
      const resp = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TURN_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL }),
        },
      );
      if (!resp.ok) {
        app.log.error({ status: resp.status }, 'Cloudflare TURN API 失败');
        reply.code(502);
        return { error: 'TURN 服务暂不可用' };
      }
      const data = await resp.json();
      cachedIceServers = data as { iceServers: unknown };
      cacheExpiresAt = Date.now() + TURN_CACHE_TTL * 1000;
      return data;
    } catch (err) {
      app.log.error(err, 'Cloudflare TURN 请求异常');
      reply.code(502);
      return { error: 'TURN 服务暂不可用' };
    }
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
      // WebRTC SDP 消息豁免 4KB 限制（SDP offer/answer 可达 4-8KB）
      const isRtcSignaling = (() => {
        try {
          const peek = JSON.parse(raw.toString());
          return typeof peek?.type === 'string' && peek.type.startsWith('rtc:');
        } catch { return false; }
      })();

      if (!isRtcSignaling && raw.byteLength > MAX_MSG_SIZE) {
        socket.send(JSON.stringify({
          type: 'error',
          data: { code: 'INVALID_SIZE', message: '消息大小超过 4KB 限制' },
        }));
        return;
      }

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

      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)
          || typeof msg.type !== 'string') {
        socket.send(JSON.stringify({
          type: 'error',
          data: { code: 'INVALID_JSON', message: '消息必须是 object 且 type 为 string' },
        }));
        return;
      }

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

            const prevFileInfo = user.fileInfo;
            user.fileInfo = undefined;
            if (room.state === 'playing') {
              room.state = 'selecting';
            }

            const reconnected = roomManager.reconnectUser(code, sid, socket);
            if (reconnected) {
              currentRoom = code;
              const peerOnline = roomManager.getPeerOnline(code, sid);

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
                  mode: room.mode,
                  fileName: prevFileInfo?.name,
                  fileSize: prevFileInfo?.size,
                },
              }));

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
          if (currentRoom) {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'ALREADY_IN_ROOM', message: '你已在房间中' },
            }));
            break;
          }
          const mode: RoomMode = (msg.data as { mode?: RoomMode } | undefined)?.mode ?? 'local-sync';
          if (!['local-sync', 'file-transfer', 'screen-share'].includes(mode)) {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'INVALID_MODE', message: '无效的房间模式' },
            }));
            break;
          }
          let room;
          try {
            room = roomManager.createRoom(sessionId!, socket, mode);
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
            data: { roomCode: room.code, role: 'host', mode: room.mode, peerCount: 0 },
          }));
          break;
        }

        case 'room:join': {
          const code = (msg.data as { roomCode: string }).roomCode;

          if (!ROOM_CODE_REGEX.test(code)) {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'INVALID_ROOM', message: '房间号格式无效' },
            }));
            break;
          }

          const existing = roomManager.getRoom(code);
          const alreadyIn = existing?.users.has(sessionId!) ?? false;

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

          roomManager.clearDisconnectTimer(sessionId!);

          const me = room.users.get(sessionId!)!;
          socket.send(JSON.stringify({
            type: 'room:joined',
            room: code,
            data: {
              userId: sessionId,
              role: me.role,
              peerCount: room.users.size - 1,
              mode: room.mode,
              rejoin: alreadyIn,
            },
          }));

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

        // ─── 屏幕分享协调（Stage 2） ──────────────────
        case 'screen:request': {
          if (!currentRoom) break;
          const room = roomManager.getRoom(currentRoom);
          if (!room) break;
          if (room.screenSharer && room.screenSharer !== sessionId) {
            socket.send(JSON.stringify({
              type: 'screen:busy',
              data: { sharer: room.screenSharer },
            }));
            break;
          }
          room.screenSharer = sessionId!;
          socket.send(JSON.stringify({ type: 'screen:grant', data: {} }));
          // 不广播 grant（对方通过后续 rtc:offer/track 感知分享开始）
          break;
        }

        case 'screen:stop': {
          if (!currentRoom) break;
          const room = roomManager.getRoom(currentRoom);
          if (!room) break;
          if (room.screenSharer === sessionId) {
            room.screenSharer = null;
          }
          roomManager.broadcast(currentRoom, {
            type: 'screen:stop',
            room: currentRoom,
            data: {},
          }, sessionId!);
          break;
        }

        // 同步/聊天/信令消息：白名单校验后转发
        default: {
          if (msg.type === 'chat:message') {
            const text = (msg.data as { text?: string } | undefined)?.text;
            if (typeof text === 'string' && text.length > CHAT_MAX_LENGTH) {
              (msg.data as { text: string }).text = text.slice(0, CHAT_MAX_LENGTH);
            }
          }

          if (FORWARD_WHITELIST.has(msg.type)) {
            if (!currentRoom && !NO_ROOM_TYPES.has(msg.type)) break;
            if (msg.type.startsWith('rtc:')) {
              console.log(`[SVR] 转发 ${msg.type}, room=${currentRoom}, from=${sessionId}, size=${raw.byteLength}B`);
            }
            roomManager.broadcast(currentRoom!, {
              ...msg,
              from: sessionId,
              room: currentRoom ?? undefined,
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