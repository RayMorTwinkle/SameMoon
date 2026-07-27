/**
 * 客户端测试基础设施（TECH-SPEC §8.2）
 * 伪时钟 + 内存传输 + 伪适配器，用于 SyncEngine 纯逻辑单测
 */

import type { PlaybackAdapter, PlaybackSource, AdapterEvent } from '../src/services/playback/PlaybackAdapter';
import type { SyncTransport } from '../src/services/sync/SyncEngine';
import type { Clock } from '../src/services/sync/ClockSync';

/** 可控时钟：测试中手动推进时间 */
export class FakeClock implements Clock {
  private nowMs: number;
  private timers: Array<{ id: number; at: number; cb: () => void }> = [];
  private nextId = 1;

  constructor(startMs = 1_000_000) {
    this.nowMs = startMs;
  }

  now(): number {
    return this.nowMs;
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    // 循环触发所有到期的 timer（含 setInterval 重新注册的）
    // 每次循环重新扫描，因为 cb 可能注册新 timer
    let loopGuard = 0;
    while (loopGuard++ < 1000) {
      const due = this.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      // 只触发最早到期的那一个（cb 执行时可能注册新 timer 或修改时间）
      const t = due[0];
      this.timers = this.timers.filter(x => x.id !== t.id);
      this.nowMs = t.at; // 跳到该 timer 的触发时刻
      t.cb();
    }
    this.nowMs = target;
  }

  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.push({ id, at: this.nowMs + ms, cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(id: ReturnType<typeof setTimeout>): void {
    this.timers = this.timers.filter(t => t.id !== id);
  }

  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = this.nextId++;
    const wrapper = () => {
      cb();
      // 重新注册下一次（保持周期性）
      const existing = this.timers.find(t => t.id === id);
      if (existing) existing.at = this.nowMs + ms;
    };
    this.timers.push({ id, at: this.nowMs + ms, cb: wrapper });
    return id as unknown as ReturnType<typeof setInterval>;
  }

  clearInterval(id: ReturnType<typeof setInterval>): void {
    this.timers = this.timers.filter(t => t.id !== id);
  }
}

/** 内存传输：A → B 直接投递，不经过 WS */
export class MemoryTransport {
  private peer: { handleRemote: (msg: Record<string, unknown>) => void } | null = null;
  public sent: Record<string, unknown>[] = [];

  connect(peer: { handleRemote: (msg: Record<string, unknown>) => void }): void {
    this.peer = peer;
  }

  send(msg: Record<string, unknown>): void {
    this.sent.push(msg);
    if (this.peer) {
      // 同步投递（简化时序，便于测试）
      this.peer.handleRemote(msg);
    }
  }

  reset(): void {
    this.sent = [];
  }
}

/** 伪适配器：记录所有方法调用，可手动触发事件 */
export class FakeAdapter implements PlaybackAdapter {
  currentTime = 0;
  paused = true;
  rate = 1;
  destroyed = false;

  calls: Array<{ method: string; args: unknown[] }> = [];
  private listeners = new Map<AdapterEvent, Set<() => void>>();

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async load(_source: PlaybackSource): Promise<void> {
    this.record('load');
  }

  async play(): Promise<void> {
    this.record('play');
    this.paused = false;
    this.emit('play');
  }

  pause(): void {
    this.record('pause');
    this.paused = true;
    this.emit('pause');
  }

  seek(time: number): void {
    this.record('seek', time);
    this.currentTime = time;
    this.emit('seeked');
  }

  setRate(rate: number): void {
    this.record('setRate', rate);
    this.rate = rate;
    this.emit('ratechange');
  }

  getTime(): number {
    return this.currentTime;
  }

  getPaused(): boolean {
    return this.paused;
  }

  getRate(): number {
    return this.rate;
  }

  on(evt: AdapterEvent, cb: () => void): () => void {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(cb);
    return () => { this.listeners.get(evt)?.delete(cb); };
  }

  destroy(): void {
    this.record('destroy');
    this.destroyed = true;
    this.listeners.clear();
  }

  /** 测试用：手动触发事件 */
  emit(evt: AdapterEvent): void {
    this.listeners.get(evt)?.forEach(cb => cb());
  }

  resetCalls(): void {
    this.calls = [];
  }
}

/** 把两个 SyncEngine 的 transport 对接起来，模拟双人直连 */
export function linkEngines(
  engineA: { handleRemoteMessage: (msg: Record<string, unknown>) => void },
  engineB: { handleRemoteMessage: (msg: Record<string, unknown>) => void },
): { transportA: SyncTransport; transportB: SyncTransport } {
  const transportA: SyncTransport = {
    send: (msg) => engineB.handleRemoteMessage(msg),
  };
  const transportB: SyncTransport = {
    send: (msg) => engineA.handleRemoteMessage(msg),
  };
  return { transportA, transportB };
}
