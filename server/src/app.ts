import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { RoomManager } from './room/RoomManager.js';
import type { WsMessage } from './ws/protocol.js';

/** 构建 Fastify 应用（导出以便测试） */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const roomManager = new RoomManager();

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // 健康检查
  app.get('/health', async () => {
    return { status: 'ok', rooms: roomManager.activeRoomCount };
  });

  // WebSocket 信令入口
  app.get('/ws', { websocket: true }, (socket, _req) => {
    const userId = randomUUID();
    let currentRoom: string | null = null;

    socket.send(JSON.stringify({
      type: 'connected',
      data: { userId },
    }));

    socket.on('message', (raw: Buffer) => {
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

      switch (msg.type) {
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
            room = roomManager.createRoom(userId, socket);
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
          const existing = roomManager.getRoom(code);
          const alreadyIn = existing?.users.has(userId) ?? false;

          const room = roomManager.joinRoom(code, userId, socket);
          if (!room) {
            socket.send(JSON.stringify({
              type: 'error',
              data: { code: 'ROOM_NOT_FOUND', message: '房间不存在或已满' },
            }));
            break;
          }
          currentRoom = code;

          const me = room.users.get(userId)!;
          // 回复加入者（幂等：重复 join 返回当前实际角色，不产生副作用）
          socket.send(JSON.stringify({
            type: 'room:joined',
            room: code,
            data: {
              userId,
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
              data: { userId },
            }, userId);
          }
          break;
        }

        case 'file:info': {
          if (!currentRoom) break;
          const room = roomManager.getRoom(currentRoom);
          if (!room) break;

          const user = room.users.get(userId);
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

        // 同步/聊天消息：转发给对方（P2P 建立前由服务器中转）
        case 'sync:play':
        case 'sync:pause':
        case 'sync:seek':
        case 'sync:rate':
        case 'sync:heartbeat':
        case 'sync:state':
        case 'sync:buffering':
        case 'sync:ready':
        case 'player:ready':
        case 'chat:message': {
          if (!currentRoom) break;
          roomManager.broadcast(currentRoom, {
            ...msg,
            from: userId,
            room: currentRoom,
          }, userId);
          break;
        }

        default: {
          socket.send(JSON.stringify({
            type: 'error',
            data: { code: 'UNKNOWN_TYPE', message: `未知消息类型: ${msg.type}` },
          }));
        }
      }
    });

    socket.on('close', () => {
      if (currentRoom) {
        roomManager.broadcast(currentRoom, {
          type: 'room:left',
          room: currentRoom,
          data: { userId },
        }, userId);
        roomManager.leaveRoom(currentRoom, userId);
      }
    });
  });

  return app;
}
