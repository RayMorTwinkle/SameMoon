import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';

/** 测试客户端：收集消息，支持按类型等待 */
class TestClient {
  ws: WebSocket;
  messages: Record<string, unknown>[] = [];
  private waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      const idx = this.waiters.findIndex(w => w.type === msg.type);
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
      }
    });
  }

  /** 等待指定类型的消息（含已收到的） */
  waitFor(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const existing = this.messages.find(m => m.type === type);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待消息超时: ${type}`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
      });
    });
  }

  /** 确认在指定时间内没有收到某类型消息 */
  expectNo(type: string, waitMs = 500): Promise<void> {
    const before = this.messages.filter(m => m.type === type).length;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const after = this.messages.filter(m => m.type === type).length;
        if (after > before) reject(new Error(`不应收到消息: ${type}`));
        else resolve();
      }, waitMs);
    });
  }

  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify(msg));
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => this.ws.on('open', resolve));
  }

  close() {
    this.ws.close();
  }
}

describe('信令服务器集成测试（完整用户流程）', () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp();
    await app.listen({ port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('完整流程：A创建 → B加入 → 文件验证 → 同步消息转发', async () => {
    // A 连接并创建房间
    const a = new TestClient(port);
    await a.open();
    await a.waitFor('connected');
    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    const roomCode = (created.data as { roomCode: string }).roomCode;
    expect(roomCode).toMatch(/^\d{4}$/);

    // B 连接并加入
    const b = new TestClient(port);
    await b.open();
    await b.waitFor('connected');
    b.send({ type: 'room:join', data: { roomCode } });

    // B 收到 room:joined，角色是 guest，peerCount=1（A在房间里）
    const joined = await b.waitFor('room:joined');
    expect((joined.data as { role: string }).role).toBe('guest');
    expect((joined.data as { peerCount: number }).peerCount).toBe(1);

    // A 收到 peer-joined 通知
    await a.waitFor('room:peer-joined');

    // 双方提交文件信息 → 都收到 file:match
    a.send({ type: 'file:info', data: { name: 'movie.mkv', size: 1000 } });
    b.send({ type: 'file:info', data: { name: 'movie.mkv', size: 1000 } });
    const matchA = await a.waitFor('file:match');
    const matchB = await b.waitFor('file:match');
    expect((matchA.data as { matched: boolean }).matched).toBe(true);
    expect((matchB.data as { matched: boolean }).matched).toBe(true);

    // A 发同步消息 → 只有 B 收到
    a.send({ type: 'sync:play', data: { time: 12.5, timestamp: Date.now() } });
    const play = await b.waitFor('sync:play');
    expect((play.data as { time: number }).time).toBe(12.5);

    // B 关闭 → A 收到 room:left
    b.close();
    await a.waitFor('room:left');

    a.close();
  });

  it('Bug回归：房主重复 join 自己的房间，角色保持 host，且不广播 peer-joined', async () => {
    const a = new TestClient(port);
    await a.open();
    await a.waitFor('connected');
    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    const roomCode = (created.data as { roomCode: string }).roomCode;

    // 房主 join 自己的房间（模拟之前 RoomPage 的错误行为）
    a.send({ type: 'room:join', data: { roomCode } });
    const rejoined = await a.waitFor('room:joined');

    // 关键断言：角色必须还是 host，peerCount=0（没有别人）
    expect((rejoined.data as { role: string }).role).toBe('host');
    expect((rejoined.data as { peerCount: number }).peerCount).toBe(0);
    expect((rejoined.data as { rejoin: boolean }).rejoin).toBe(true);

    // 且不应收到 peer-joined（之前的 bug 表现）
    await a.expectNo('room:peer-joined');

    a.close();
  });

  it('文件不匹配：返回 matched=false 和差异信息', async () => {
    const a = new TestClient(port);
    await a.open();
    await a.waitFor('connected');
    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    const roomCode = (created.data as { roomCode: string }).roomCode;

    const b = new TestClient(port);
    await b.open();
    await b.waitFor('connected');
    b.send({ type: 'room:join', data: { roomCode } });
    await b.waitFor('room:joined');

    a.send({ type: 'file:info', data: { name: 'movie.mkv', size: 1000 } });
    b.send({ type: 'file:info', data: { name: 'movie.mkv', size: 2000 } });

    const match = await a.waitFor('file:match');
    expect((match.data as { matched: boolean }).matched).toBe(false);
    expect((match.data as { diff: string }).diff).toContain('1000');

    a.close();
    b.close();
  });

  it('加入不存在的房间：返回 ROOM_NOT_FOUND', async () => {
    const c = new TestClient(port);
    await c.open();
    await c.waitFor('connected');
    c.send({ type: 'room:join', data: { roomCode: '0000' } });
    const err = await c.waitFor('error');
    expect((err.data as { code: string }).code).toBe('ROOM_NOT_FOUND');
    c.close();
  });

  it('房间满员：第三人加入被拒绝', async () => {
    const a = new TestClient(port);
    await a.open();
    await a.waitFor('connected');
    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    const roomCode = (created.data as { roomCode: string }).roomCode;

    const b = new TestClient(port);
    await b.open();
    await b.waitFor('connected');
    b.send({ type: 'room:join', data: { roomCode } });
    await b.waitFor('room:joined');

    const c = new TestClient(port);
    await c.open();
    await c.waitFor('connected');
    c.send({ type: 'room:join', data: { roomCode } });
    const err = await c.waitFor('error');
    expect((err.data as { code: string }).code).toBe('ROOM_NOT_FOUND');

    a.close();
    b.close();
    c.close();
  });
});
