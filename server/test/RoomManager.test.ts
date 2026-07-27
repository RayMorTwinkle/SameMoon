import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RoomManager } from '../src/room/RoomManager.js';
import type { WebSocket } from 'ws';

function fakeWs(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    readyState: 1,
    send: (data: string) => { sent.push(data); },
  } as unknown as WebSocket & { sent: string[] };
}

describe('RoomManager', () => {
  let rm: RoomManager;

  beforeEach(() => {
    rm = new RoomManager({ disconnectTimeoutMs: 100 });
  });

  it('创建房间：生成4位数字房间号，创建者为 host', () => {
    const ws = fakeWs();
    const room = rm.createRoom('user-a', ws);

    expect(room.code).toMatch(/^\d{4}$/);
    expect(room.users.size).toBe(1);
    expect(room.users.get('user-a')?.role).toBe('host');
    expect(room.state).toBe('waiting');
  });

  it('加入房间：第二人加入后状态变为 selecting', () => {
    const room = rm.createRoom('user-a', fakeWs());
    const joined = rm.joinRoom(room.code, 'user-b', fakeWs());

    expect(joined).not.toBeNull();
    expect(joined!.users.size).toBe(2);
    expect(joined!.users.get('user-b')?.role).toBe('guest');
    expect(joined!.state).toBe('selecting');
  });

  it('幂等：同一用户重复加入不改变角色和人数', () => {
    const room = rm.createRoom('user-a', fakeWs());
    const rejoined = rm.joinRoom(room.code, 'user-a', fakeWs());

    expect(rejoined).not.toBeNull();
    expect(rejoined!.users.size).toBe(1);
    expect(rejoined!.users.get('user-a')?.role).toBe('host');
    expect(rejoined!.state).toBe('waiting');
  });

  it('房间满员：第三人加入被拒绝', () => {
    const room = rm.createRoom('user-a', fakeWs());
    rm.joinRoom(room.code, 'user-b', fakeWs());
    const third = rm.joinRoom(room.code, 'user-c', fakeWs());

    expect(third).toBeNull();
  });

  it('加入不存在的房间返回 null', () => {
    expect(rm.joinRoom('0000', 'user-x', fakeWs())).toBeNull();
  });

  it('所有人离开后房间销毁', () => {
    const room = rm.createRoom('user-a', fakeWs());
    rm.joinRoom(room.code, 'user-b', fakeWs());

    rm.leaveRoom(room.code, 'user-a');
    expect(rm.getRoom(room.code)).toBeDefined();

    rm.leaveRoom(room.code, 'user-b');
    expect(rm.getRoom(room.code)).toBeUndefined();
    expect(rm.activeRoomCount).toBe(0);
  });

  it('广播：排除指定用户', () => {
    const wsA = fakeWs();
    const wsB = fakeWs();
    const room = rm.createRoom('user-a', wsA);
    rm.joinRoom(room.code, 'user-b', wsB);

    rm.broadcast(room.code, { type: 'test' }, 'user-a');

    expect(wsA.sent.length).toBe(0);
    expect(wsB.sent.length).toBe(1);
    expect(JSON.parse(wsB.sent[0]).type).toBe('test');
  });

  it('断线重连流程：标记离线 → 重连换绑 ws → 恢复状态', () => {
    const wsA = fakeWs();
    const wsB1 = fakeWs();
    const room = rm.createRoom('user-a', wsA);
    rm.joinRoom(room.code, 'user-b', wsB1);
    room.state = 'playing';

    // 标记 B 离线
    rm.markOffline(room.code, 'user-b');
    expect(room.state).toBe('reconnecting');
    expect(room.users.get('user-b')!.ws).toBeNull();

    // B 重连
    const wsB2 = fakeWs();
    const reconnected = rm.reconnectUser(room.code, 'user-b', wsB2);
    expect(reconnected).toBe(true);
    expect(room.users.get('user-b')!.ws).toBe(wsB2);
    expect(room.state).toBe('playing');
  });

  it('断线超时 → forceRemove 清理用户', () => {
    const wsA = fakeWs();
    const wsB = fakeWs();
    const room = rm.createRoom('user-a', wsA);
    rm.joinRoom(room.code, 'user-b', wsB);

    // 标记 B 离线
    rm.markOffline(room.code, 'user-b');

    // 启动超时定时器
    let expiredSessionId: string | null = null;
    let expiredRoomCode: string | null = null;
    rm.onDisconnectExpired = (sid, code) => {
      expiredSessionId = sid;
      expiredRoomCode = code;
    };
    rm.startDisconnectTimer('user-b', room.code);

    // 等待超时
    vi.useFakeTimers();
    rm.startDisconnectTimer('user-b', room.code);
    vi.advanceTimersByTime(150);
    vi.useRealTimers();

    expect(expiredSessionId).toBe('user-b');
    expect(expiredRoomCode).toBe(room.code);

    // 强制移除
    rm.forceRemove(room.code, 'user-b');
    expect(room.users.has('user-b')).toBe(false);
  });

  it('重连时清除断线定时器', () => {
    const room = rm.createRoom('user-a', fakeWs());
    rm.joinRoom(room.code, 'user-b', fakeWs());
    rm.markOffline(room.code, 'user-b');

    let expired = false;
    rm.onDisconnectExpired = () => { expired = true; };
    rm.startDisconnectTimer('user-b', room.code);

    // 重连
    rm.reconnectUser(room.code, 'user-b', fakeWs());
    rm.clearDisconnectTimer('user-b');

    // 超时不应触发
    expect(expired).toBe(false);
  });

  it('getPeerOnline：正确反映对方在线状态', () => {
    const room = rm.createRoom('user-a', fakeWs());
    expect(rm.getPeerOnline(room.code, 'user-a')).toBe(false);

    rm.joinRoom(room.code, 'user-b', fakeWs());
    expect(rm.getPeerOnline(room.code, 'user-a')).toBe(true);

    rm.markOffline(room.code, 'user-b');
    expect(rm.getPeerOnline(room.code, 'user-a')).toBe(false);
  });

  // ─── Stage 2: mode 和 screenSharer ─────────────────
  it('默认模式为 local-sync', () => {
    const room = rm.createRoom('user-a', fakeWs());
    expect(room.mode).toBe('local-sync');
    expect(room.screenSharer).toBeNull();
  });

  it('可指定其他模式创建房间', () => {
    const roomFile = rm.createRoom('user-a', fakeWs(), 'file-transfer');
    expect(roomFile.mode).toBe('file-transfer');

    const roomScreen = rm.createRoom('user-b', fakeWs(), 'screen-share');
    expect(roomScreen.mode).toBe('screen-share');
  });

  it('forceRemove 清除 screenSharer（若被移除者是分享者）', () => {
    const room = rm.createRoom('user-a', fakeWs(), 'screen-share');
    room.screenSharer = 'user-a';
    rm.forceRemove(room.code, 'user-a');
    expect(room.screenSharer).toBeNull();
  });

  it('leaveRoom 清除 screenSharer', () => {
    const room = rm.createRoom('user-a', fakeWs(), 'screen-share');
    room.screenSharer = 'user-a';
    rm.leaveRoom(room.code, 'user-a');
    expect(room.screenSharer).toBeNull();
  });
});
