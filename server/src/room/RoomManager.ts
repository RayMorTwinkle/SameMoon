import type { WebSocket } from 'ws';

export interface RoomUser {
  id: string;
  ws: WebSocket | null; // null = 离线
  role: 'host' | 'guest';
  fileInfo?: { name: string; size: number };
}

export interface Room {
  code: string;
  users: Map<string, RoomUser>;
  createdAt: number;
  state: 'waiting' | 'selecting' | 'playing' | 'reconnecting' | 'closed';
}

export interface RoomManagerOptions {
  /** 断线重连超时（ms），默认 30_000，可测试注入 */
  disconnectTimeoutMs?: number;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly disconnectTimeoutMs: number;

  private static readonly MAX_ROOMS = 5000;

  /** 外部回调：定时器到期时通知 app 层执行清理 */
  onDisconnectExpired?: (sessionId: string, roomCode: string) => void;

  constructor(opts: RoomManagerOptions = {}) {
    this.disconnectTimeoutMs = opts.disconnectTimeoutMs ?? 30_000;
  }

  /** 生成 4 位数字房间号 */
  generateCode(): string {
    if (this.rooms.size >= RoomManager.MAX_ROOMS) {
      throw new Error('SERVER_FULL');
    }
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
    // 幂等：已在房间内的用户重复 join，直接返回房间（不改变角色/人数）
    if (room.users.has(userId)) {
      // 更新 ws 引用（可能是新连接）
      room.users.get(userId)!.ws = ws;
      return room;
    }
    if (room.users.size >= 2) return null;

    room.users.set(userId, { id: userId, ws, role: 'guest' });
    if (room.users.size === 2) {
      room.state = 'selecting';
    }
    return room;
  }

  /** 标记用户离线（不清除用户，保留 fileInfo 等） */
  markOffline(code: string, userId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const user = room.users.get(userId);
    if (user) {
      user.ws = null;
      room.state = 'reconnecting';
    }
  }

  /** 重连：换绑新 ws，取消离线倒计时 */
  reconnectUser(code: string, userId: string, ws: WebSocket): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;
    const user = room.users.get(userId);
    if (!user) return false;
    user.ws = ws;
    // 恢复房间状态
    if (room.users.size === 2) {
      const allOnline = [...room.users.values()].every(u => u.ws !== null);
      room.state = allOnline ? 'playing' : 'reconnecting';
    } else {
      room.state = 'waiting';
    }
    // 清除断线倒计时
    this.clearDisconnectTimer(userId);
    return true;
  }

  /** 强制移除用户（断线超时或主动离开） */
  forceRemove(code: string, userId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.users.delete(userId);
    this.clearDisconnectTimer(userId);
    if (room.users.size === 0) {
      this.destroyRoom(code);
    }
  }

  /** 启动断线倒计时 */
  startDisconnectTimer(sessionId: string, roomCode: string): void {
    this.clearDisconnectTimer(sessionId);
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(sessionId);
      this.onDisconnectExpired?.(sessionId, roomCode);
    }, this.disconnectTimeoutMs);
    this.disconnectTimers.set(sessionId, timer);
  }

  /** 清除断线倒计时 */
  clearDisconnectTimer(sessionId: string): void {
    const timer = this.disconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(sessionId);
    }
  }

  /** 查询对方是否在线 */
  getPeerOnline(code: string, excludeId: string): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;
    for (const [id, user] of room.users) {
      if (id !== excludeId && user.ws !== null) return true;
    }
    return false;
  }

  /** 查找 sessionId 所在的房间（用于重连检查） */
  findUserRoom(sessionId: string): { roomCode: string; room: Room } | null {
    for (const [code, room] of this.rooms) {
      if (room.users.has(sessionId)) {
        return { roomCode: code, room };
      }
    }
    return null;
  }

  /** 清除指定 session 的所有断线定时器 */
  disposeSession(sessionId: string): void {
    this.clearDisconnectTimer(sessionId);
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
      // 清除房间内所有用户的断线定时器
      for (const userId of room.users.keys()) {
        this.clearDisconnectTimer(userId);
      }
      this.rooms.delete(code);
    }
  }

  /** 向房间内所有在线用户广播 */
  broadcast(code: string, message: object, excludeId?: string): void {
    const room = this.rooms.get(code);
    if (!room) return;

    const payload = JSON.stringify(message);
    for (const user of room.users.values()) {
      if (user.id !== excludeId && user.ws && user.ws.readyState === 1) {
        user.ws.send(payload);
      }
    }
  }

  /** 向指定用户发送 */
  sendTo(userId: string, code: string, message: object): void {
    const room = this.rooms.get(code);
    if (!room) return;

    const user = room.users.get(userId);
    if (user && user.ws && user.ws.readyState === 1) {
      user.ws.send(JSON.stringify(message));
    }
  }

  get activeRoomCount(): number {
    return this.rooms.size;
  }
}
