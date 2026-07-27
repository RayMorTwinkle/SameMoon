import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';

let clientCounter = 0;

/** 测试客户端：收集消息，支持按类型等待，自动发送 session:hello */
class TestClient {
  ws: WebSocket;
  messages: Record<string, unknown>[] = [];
  sessionId: string;
  userId: string | null = null;
  private waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];

  constructor(port: number, sessionId?: string) {
    this.sessionId = sessionId ?? `test-${++clientCounter}-${Date.now()}`;
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      // 记录 userId
      if (msg.type === 'connected' && msg.data) {
        this.userId = (msg.data as { userId: string }).userId;
      }
      const idx = this.waiters.findIndex(w => w.type === msg.type);
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
      }
    });
  }

  waitFor(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const existing = this.messages.find(m => m.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待消息超时: ${type}`)), timeoutMs);
      this.waiters.push({ type, resolve: (m: Record<string, unknown>) => { clearTimeout(timer); resolve(m); } });
    });
  }

  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify(msg));
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

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve) => this.ws.on('open', resolve));
    // 发送 session:hello
    this.send({ type: 'session:hello', data: { sessionId: this.sessionId } });
    await this.waitFor('connected');
  }

  close() {
    this.ws.close();
  }
}

describe('信令服务器集成测试（完整用户流程 + session 重连）', () => {
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
    const a = new TestClient(port, 'user-a');
    await a.open();

    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    const roomCode = (created.data as { roomCode: string }).roomCode;
    expect(roomCode).toMatch(/^\d{4}$/);

    const b = new TestClient(port, 'user-b');
    await b.open();

    b.send({ type: 'room:join', data: { roomCode } });

    const joined = await b.waitFor('room:joined');
    expect((joined.data as { role: string }).role).toBe('guest');
    expect((joined.data as { peerCount: number }).peerCount).toBe(1);

    await a.waitFor('room:peer-joined');

    a.send({ type: 'file:info', data: { name: 'movie.mkv', size: 1000 } });
    b.send({ type: 'file:info', data: { name: 'movie.mkv', size: 1000 } });
    const matchA = await a.waitFor('file:match');
    const matchB = await b.waitFor('file:match');
    expect((matchA.data as { matched: boolean }).matched).toBe(true);
    expect((matchB.data as { matched: boolean }).matched).toBe(true);

    a.send({ type: 'sync:play', data: { time: 12.5, timestamp: Date.now() } });
    const play = await b.waitFor('sync:play');
    expect((play.data as { time: number }).time).toBe(12.5);

    b.close();
    await a.waitFor('room:left');

    a.close();
  });

  it('Bug回归：房主重复 join 自己的房间，角色保持 host，且不广播 peer-joined', async () => {
    const a = new TestClient(port, 'user-a-rj');
    await a.open();

    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    const roomCode = (created.data as { roomCode: string }).roomCode;

    a.send({ type: 'room:join', data: { roomCode } });
    const rejoined = await a.waitFor('room:joined');

    expect((rejoined.data as { role: string }).role).toBe('host');
    expect((rejoined.data as { peerCount: number }).peerCount).toBe(0);
    expect((rejoined.data as { rejoin: boolean }).rejoin).toBe(true);

    await a.expectNo('room:peer-joined');

    a.close();
  });

  it('文件不匹配：返回 matched=false 和差异信息', async () => {
    const a = new TestClient(port, 'user-a-fm');
    await a.open();
    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    const roomCode = (created.data as { roomCode: string }).roomCode;

    const b = new TestClient(port, 'user-b-fm');
    await b.open();
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
    const c = new TestClient(port, 'user-c-nf');
    await c.open();
    c.send({ type: 'room:join', data: { roomCode: '0000' } });
    const err = await c.waitFor('error');
    expect((err.data as { code: string }).code).toBe('ROOM_NOT_FOUND');
    c.close();
  });

  it('房间满员：第三人加入被拒绝', async () => {
    const a = new TestClient(port, 'user-a-full');
    await a.open();
    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    const roomCode = (created.data as { roomCode: string }).roomCode;

    const b = new TestClient(port, 'user-b-full');
    await b.open();
    b.send({ type: 'room:join', data: { roomCode } });
    await b.waitFor('room:joined');

    const c = new TestClient(port, 'user-c-full');
    await c.open();
    c.send({ type: 'room:join', data: { roomCode } });
    const err = await c.waitFor('error');
    expect((err.data as { code: string }).code).toBe('ROOM_NOT_FOUND');

    a.close();
    b.close();
    c.close();
  });

  it('安全加固：无效 roomCode 被拒绝', async () => {
    const c = new TestClient(port, 'user-badcode');
    await c.open();
    c.send({ type: 'room:join', data: { roomCode: 'abc' } });
    const err = await c.waitFor('error');
    expect((err.data as { code: string }).code).toBe('INVALID_ROOM');
    c.close();
  });

  it('安全加固：未 hello 直接发其他消息被拒绝', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'room:create', data: {} }));
    const err = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
    });
    expect((err.data as { code: string }).code).toBe('AUTH_REQUIRED');
    ws.close();
  });

  it('安全加固：超大消息被拒绝', async () => {
    const c = new TestClient(port, 'user-big');
    await c.open();
    // 发送超过 4KB 的消息
    c.ws.send(JSON.stringify({ type: 'sync:play', data: { time: 0, pad: 'x'.repeat(5000) } }));
    const err = await c.waitFor('error');
    expect((err.data as { code: string }).code).toBe('INVALID_SIZE');
    c.close();
  });

  // ─── Stage 2: 模式系统 ─────────────────────────────
  it('Stage 2：room:created 携带默认 mode=local-sync', async () => {
    const a = new TestClient(port, 'user-mode-a');
    await a.open();
    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    expect((created.data as { mode: string }).mode).toBe('local-sync');
    a.close();
  });

  it('Stage 2：创建 file-transfer 模式房间', async () => {
    const a = new TestClient(port, 'user-mode-ft');
    await a.open();
    a.send({ type: 'room:create', data: { mode: 'file-transfer' } });
    const created = await a.waitFor('room:created');
    expect((created.data as { mode: string }).mode).toBe('file-transfer');

    // Guest 加入也要带 mode
    const b = new TestClient(port, 'user-mode-ft-b');
    await b.open();
    const code = (created.data as { roomCode: string }).roomCode;
    b.send({ type: 'room:join', data: { roomCode: code } });
    const joined = await b.waitFor('room:joined');
    expect((joined.data as { mode: string }).mode).toBe('file-transfer');
    a.close();
    b.close();
  });

  it('Stage 2：无效模式被拒绝', async () => {
    const a = new TestClient(port, 'user-badmode');
    await a.open();
    a.send({ type: 'room:create', data: { mode: 'invalid-mode' } });
    const err = await a.waitFor('error');
    expect((err.data as { code: string }).code).toBe('INVALID_MODE');
    a.close();
  });

  // ─── Stage 2: 屏幕分享协调 ─────────────────────────
  it('Stage 2：screen:request → grant，同一时刻只有一个分享者', async () => {
    const a = new TestClient(port, 'user-scr-a');
    await a.open();
    a.send({ type: 'room:create', data: { mode: 'screen-share' } });
    const created = await a.waitFor('room:created');
    const code = (created.data as { roomCode: string }).roomCode;

    const b = new TestClient(port, 'user-scr-b');
    await b.open();
    b.send({ type: 'room:join', data: { roomCode: code } });
    await b.waitFor('room:joined');

    // A 请求分享 → grant
    a.send({ type: 'screen:request', data: {} });
    const grantA = await a.waitFor('screen:grant');
    expect(grantA.type).toBe('screen:grant');

    // B 也请求 → busy
    b.send({ type: 'screen:request', data: {} });
    const busyB = await b.waitFor('screen:busy');
    expect((busyB.data as { sharer: string }).sharer).toBe(a.userId);

    // A 停止分享
    a.send({ type: 'screen:stop', data: {} });
    await b.waitFor('screen:stop');

    // 现在 B 可以请求成功
    b.send({ type: 'screen:request', data: {} });
    const grantB = await b.waitFor('screen:grant');
    expect(grantB.type).toBe('screen:grant');

    a.close();
    b.close();
  });

  // ─── Stage 2: RTC 信令转发 ─────────────────────────
  it('Stage 2：rtc:offer/answer/ice 在房间内转发', async () => {
    const a = new TestClient(port, 'user-rtc-a');
    await a.open();
    a.send({ type: 'room:create', data: { mode: 'screen-share' } });
    const created = await a.waitFor('room:created');
    const code = (created.data as { roomCode: string }).roomCode;

    const b = new TestClient(port, 'user-rtc-b');
    await b.open();
    b.send({ type: 'room:join', data: { roomCode: code } });
    await b.waitFor('room:joined');

    // A → offer → B
    a.send({ type: 'rtc:offer', data: { sdp: 'v=0...' } });
    const offer = await b.waitFor('rtc:offer');
    expect((offer.data as { sdp: string }).sdp).toBe('v=0...');
    expect(offer.from).toBe(a.userId);

    // B → answer → A
    b.send({ type: 'rtc:answer', data: { sdp: 'v=0...answer' } });
    const answer = await a.waitFor('rtc:answer');
    expect((answer.data as { sdp: string }).sdp).toBe('v=0...answer');

    // ICE candidates 转发
    a.send({ type: 'rtc:ice', data: { candidate: 'candidate:1...' } });
    const ice = await b.waitFor('rtc:ice');
    expect((ice.data as { candidate: string }).candidate).toBe('candidate:1...');

    a.close();
    b.close();
  });

  // ─── Stage 2: 文件传输消息转发 ─────────────────────
  it('Stage 2：file:offer/progress/complete 在房间内转发', async () => {
    const a = new TestClient(port, 'user-ft-a');
    await a.open();
    a.send({ type: 'room:create', data: { mode: 'file-transfer' } });
    const created = await a.waitFor('room:created');
    const code = (created.data as { roomCode: string }).roomCode;

    const b = new TestClient(port, 'user-ft-b');
    await b.open();
    b.send({ type: 'room:join', data: { roomCode: code } });
    await b.waitFor('room:joined');

    // Host 发送 file:offer
    a.send({ type: 'file:offer', data: { name: 'movie.mp4', size: 5000000, type: 'video/mp4' } });
    const offer = await b.waitFor('file:offer');
    expect((offer.data as { name: string }).name).toBe('movie.mp4');

    // Host 发送 file:progress
    a.send({ type: 'file:progress', data: { transferred: 1000000, total: 5000000 } });
    const progress = await b.waitFor('file:progress');
    expect((progress.data as { transferred: number }).transferred).toBe(1000000);

    // Host 发送 file:complete
    a.send({ type: 'file:complete', data: {} });
    await b.waitFor('file:complete');

    a.close();
    b.close();
  });
});
