import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager } from '../src/room/RoomManager.js';
import type { WebSocket } from 'ws';

/** 伪造一个 WebSocket（只记录发送的消息） */
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
    rm = new RoomManager();
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

  it('幂等：同一用户重复加入不改变角色和人数（房主 join 自己的房间不会变 guest）', () => {
    const room = rm.createRoom('user-a', fakeWs());
    // 房主重复 join（这正是之前 bug 的场景）
    const rejoined = rm.joinRoom(room.code, 'user-a', fakeWs());

    expect(rejoined).not.toBeNull();
    expect(rejoined!.users.size).toBe(1);
    expect(rejoined!.users.get('user-a')?.role).toBe('host'); // 角色不变！
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
    expect(rm.getRoom(room.code)).toBeDefined(); // 还有 b

    rm.leaveRoom(room.code, 'user-b');
    expect(rm.getRoom(room.code)).toBeUndefined(); // 销毁
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
});
