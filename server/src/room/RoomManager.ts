import type { WebSocket } from 'ws';

export interface RoomUser {
  id: string;
  ws: WebSocket;
  role: 'host' | 'guest';
  fileInfo?: { name: string; size: number };
}

export interface Room {
  code: string;
  users: Map<string, RoomUser>;
  createdAt: number;
  state: 'waiting' | 'selecting' | 'playing' | 'reconnecting' | 'closed';
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  /** 生成 4 位数字房间号 */
  generateCode(): string {
    let code: string;
    do {
      code = String(Math.floor(1000 + Math.random() * 9000));
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(hostId: string, ws: WebSocket): Room {
    const code = this.generateCode();
    const room: Room = {
      code,
      users: new Map([[hostId, { id: hostId, ws, role: 'host' }]]),
      createdAt: Date.now(),
      state: 'waiting',
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  joinRoom(code: string, userId: string, ws: WebSocket): Room | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (room.users.size >= 2) return null;

    room.users.set(userId, { id: userId, ws, role: 'guest' });
    if (room.users.size === 2) {
      room.state = 'selecting';
    }
    return room;
  }

  leaveRoom(code: string, userId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;

    room.users.delete(userId);
    if (room.users.size === 0) {
      this.destroyRoom(code);
    }
  }

  destroyRoom(code: string): void {
    const room = this.rooms.get(code);
    if (room) {
      room.state = 'closed';
      this.rooms.delete(code);
    }
  }

  /** 向房间内所有用户广播 */
  broadcast(code: string, message: object, excludeId?: string): void {
    const room = this.rooms.get(code);
    if (!room) return;

    const payload = JSON.stringify(message);
    for (const user of room.users.values()) {
      if (user.id !== excludeId && user.ws.readyState === 1) {
        user.ws.send(payload);
      }
    }
  }

  /** 向指定用户发送 */
  sendTo(userId: string, code: string, message: object): void {
    const room = this.rooms.get(code);
    if (!room) return;

    const user = room.users.get(userId);
    if (user && user.ws.readyState === 1) {
      user.ws.send(JSON.stringify(message));
    }
  }

  get activeRoomCount(): number {
    return this.rooms.size;
  }
}
