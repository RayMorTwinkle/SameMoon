/**
 * 服务端同步转发集成测试（TECH-SPEC Step 4.3）
 * 验证 sync/buffering/ready/state 消息经服务器正确转发
 * 适配 session:hello 身份模型
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';

let clientCounter = 0;

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

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve) => this.ws.on('open', resolve));
    this.send({ type: 'session:hello', data: { sessionId: this.sessionId } });
    await this.waitFor('connected');
  }

  close() {
    this.ws.close();
  }
}

describe('服务端 sync 转发', () => {
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

  /** 辅助：创建房间并让 B 加入 */
  async function setupRoom(): Promise<{ a: TestClient; b: TestClient; code: string }> {
    const a = new TestClient(port);
    await a.open();
    a.send({ type: 'room:create', data: {} });
    const created = await a.waitFor('room:created');
    const code = (created.data as { roomCode: string }).roomCode;

    const b = new TestClient(port);
    await b.open();
    b.send({ type: 'room:join', data: { roomCode: code } });
    await b.waitFor('room:joined');
    await a.waitFor('room:peer-joined');

    return { a, b, code };
  }

  it('sync:play 转发：A 发 → B 收到，带 from 字段', async () => {
    const { a, b } = await setupRoom();
    a.send({ type: 'sync:play', data: { time: 12.5, timestamp: 1000 } });
    const msg = await b.waitFor('sync:play');
    expect((msg.data as { time: number }).time).toBe(12.5);
    expect(msg.from).toBe(a.userId);
    a.close();
    b.close();
  });

  it('sync:heartbeat 双向转发：请求 + 响应字段完整', async () => {
    const { a, b } = await setupRoom();
    a.send({
      type: 'sync:heartbeat',
      data: { clientTime: 1000, time: 50, paused: false, rate: 1 },
    });
    const req = await b.waitFor('sync:heartbeat');
    expect((req.data as { clientTime: number }).clientTime).toBe(1000);
    expect((req.data as { time: number }).time).toBe(50);
    expect(req.from).toBeDefined();

    b.send({
      type: 'sync:heartbeat',
      data: { echoOf: 1000, t1: 1010, clientTime: 1020, time: 51, paused: false, rate: 1 },
    });
    const res = await a.waitFor('sync:heartbeat');
    expect((res.data as { echoOf: number }).echoOf).toBe(1000);
    expect((res.data as { t1: number }).t1).toBe(1010);
    a.close();
    b.close();
  });

  it('sync:buffering / sync:ready 转发', async () => {
    const { a, b } = await setupRoom();
    a.send({ type: 'sync:buffering', data: { time: 30 } });
    const buf = await b.waitFor('sync:buffering');
    expect((buf.data as { time: number }).time).toBe(30);

    a.send({ type: 'sync:ready', data: { time: 31 } });
    const rd = await b.waitFor('sync:ready');
    expect((rd.data as { time: number }).time).toBe(31);
    a.close();
    b.close();
  });

  it('sync:state 请求/响应转发', async () => {
    const { a, b } = await setupRoom();
    a.send({ type: 'sync:state', data: {} });
    const req = await b.waitFor('sync:state');
    expect(req.data).toEqual({});

    b.send({
      type: 'sync:state',
      data: { paused: false, time: 42, rate: 1.5, seq: 3, senderId: b.userId, sentAt: 9999 },
    });
    const res = await a.waitFor('sync:state');
    expect((res.data as { time: number }).time).toBe(42);
    expect((res.data as { seq: number }).seq).toBe(3);
    a.close();
    b.close();
  });

  it('player:ready 转发', async () => {
    const { a, b } = await setupRoom();
    a.send({ type: 'player:ready', data: {} });
    const msg = await b.waitFor('player:ready');
    expect(msg.type).toBe('player:ready');
    a.close();
    b.close();
  });
});
