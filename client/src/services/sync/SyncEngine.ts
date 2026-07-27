/**
 * 同步引擎核心
 * 见 TECH-SPEC §1.3-1.7
 * 与传输层解耦（§1.8）：不 import WebSocket/RTC
 */

import type { PlaybackAdapter } from '../playback/PlaybackAdapter';
import { ClockSync } from './ClockSync';

export interface PlaybackState {
  paused: boolean;
  time: number;
  rate: number;
  seq: number;
  senderId: string;
  sentAt: number; // 校准后统一时间（ms）
}

export interface SyncTransport {
  send(msg: Record<string, unknown>): void;
}

interface SyncEngineOptions {
  adapter: PlaybackAdapter;
  transport: SyncTransport;
  clockSync: ClockSync;
  userId: string;
  /** 漂移校正阈值（秒），可测试时注入 */
  driftIgnoreThreshold?: number;   // 默认 0.3
  driftRateThreshold?: number;     // 默认 2.0
  /** 回声抑制排空窗口（ms） */
  echoWindow?: number;             // 默认 150
}

export class SyncEngine {
  private adapter: PlaybackAdapter;
  private transport: SyncTransport;
  private clock: ClockSync;
  private userId: string;

  private seq = 0;
  private applyingRemote = false;
  private echoTimer: ReturnType<typeof setTimeout> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => void> = [];

  private readonly driftIgnore: number;
  private readonly driftRate: number;
  private readonly echoWindow: number;

  // 变速追赶状态
  private chasing = false;

  constructor(opts: SyncEngineOptions) {
    this.adapter = opts.adapter;
    this.transport = opts.transport;
    this.clock = opts.clockSync;
    this.userId = opts.userId;
    this.driftIgnore = opts.driftIgnoreThreshold ?? 0.3;
    this.driftRate = opts.driftRateThreshold ?? 2.0;
    this.echoWindow = opts.echoWindow ?? 150;
  }

  /** 启动：挂接本地事件 + 开始漂移检测 */
  start(): void {
    // 本地播放器事件 → 广播（回声检查）
    this.unsubscribers.push(
      this.adapter.on('play', () => this.onLocalEvent('sync:play')),
      this.adapter.on('pause', () => this.onLocalEvent('sync:pause')),
      this.adapter.on('seeked', () => this.onLocalEvent('sync:seek')),
      this.adapter.on('ratechange', () => this.onLocalEvent('sync:rate')),
      this.adapter.on('waiting', () => this.onBuffering()),
      this.adapter.on('canplay', () => this.onReady()),
    );

    // 每 5s 漂移检测（复用心跳节奏）
    this.driftTimer = setInterval(() => this.checkDrift(), 5000);
  }

  /** 停止：清理所有监听和定时器 */
  stop(): void {
    this.unsubscribers.forEach(fn => fn());
    this.unsubscribers = [];
    if (this.driftTimer) clearInterval(this.driftTimer);
    if (this.echoTimer) clearTimeout(this.echoTimer);
  }

  /** 处理来自远端的同步消息 */
  handleRemoteMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    const data = msg.data as Record<string, unknown>;

    switch (type) {
      case 'sync:play':
      case 'sync:pause':
      case 'sync:seek':
      case 'sync:rate': {
        const state = data as unknown as PlaybackState;
        if (this.shouldAccept(state)) {
          this.applyRemote(state);
        }
        break;
      }
      case 'sync:state': {
        // 全量状态追齐（§1.7）
        const state = data as unknown as PlaybackState;
        this.seq = Math.max(this.seq, state.seq);
        this.applyRemote(state);
        break;
      }
      case 'sync:buffering': {
        // 对方在缓冲 → 暂停等待（§1.6）
        this.setApplyingRemote();
        this.adapter.pause();
        break;
      }
      case 'sync:ready': {
        // 对方就绪 → 对齐后恢复
        const time = (data as { time: number }).time;
        this.setApplyingRemote();
        this.adapter.seek(time);
        this.adapter.play().catch(() => {});
        break;
      }
      case 'sync:heartbeat': {
        // 时钟采样（§1.2）
        const d = data as { clientTime: number; serverTime?: number };
        // 对方回包时携带 serverTime = 对方收到时的时间
        // 这里简化：由调用方在收到回包时调 clock.addSample
        break;
      }
    }
  }

  /** 请求对方发送全量状态（重连/迟到追齐） */
  requestState(): void {
    this.transport.send({ type: 'sync:state', data: {} });
  }

  /** 发送当前全量状态（响应 sync:state 请求） */
  sendState(): void {
    this.transport.send({
      type: 'sync:state',
      data: this.captureState(),
    });
  }

  /** 发送心跳（携带时钟采样数据） */
  sendHeartbeat(): void {
    this.transport.send({
      type: 'sync:heartbeat',
      data: { clientTime: Date.now() },
    });
  }

  // ─── 内部方法 ───────────────────────────────────────

  private captureState(): PlaybackState {
    this.seq += 1;
    return {
      paused: this.adapter.getPaused(),
      time: this.adapter.getTime(),
      rate: this.adapter.getRate(),
      seq: this.seq,
      senderId: this.userId,
      sentAt: this.clock.now(),
    };
  }

  private onLocalEvent(type: string): void {
    if (this.applyingRemote) return; // 回声抑制（§1.3）
    if (this.chasing) {
      // 变速追赶期间用户手动操作 → 放弃追赶
      this.chasing = false;
      this.adapter.setRate(1);
    }
    this.transport.send({ type, data: this.captureState() });
  }

  private onBuffering(): void {
    if (this.applyingRemote) return;
    this.transport.send({
      type: 'sync:buffering',
      data: { time: this.adapter.getTime() },
    });
  }

  private onReady(): void {
    if (this.applyingRemote) return;
    this.transport.send({
      type: 'sync:ready',
      data: { time: this.adapter.getTime() },
    });
  }

  /** §1.5 冲突解决：seq 大者胜；seq 同则 senderId 字典序大者胜 */
  private shouldAccept(remote: PlaybackState): boolean {
    if (remote.seq > this.seq) return true;
    if (remote.seq === this.seq && remote.senderId > this.userId) return true;
    return false;
  }

  /** §1.3 施加远端状态（带回声抑制） */
  private applyRemote(state: PlaybackState): void {
    this.seq = Math.max(this.seq, state.seq);
    this.setApplyingRemote();

    // 补偿传输延迟（§1.3 末尾）
    const elapsed = (this.clock.now() - state.sentAt) / 1000;
    const targetTime = state.paused
      ? state.time
      : state.time + elapsed * state.rate;

    this.adapter.seek(targetTime);
    this.adapter.setRate(state.rate);

    if (state.paused) {
      this.adapter.pause();
    } else {
      this.adapter.play().catch(() => {});
    }
  }

  /** 设置回声抑制窗口 */
  private setApplyingRemote(): void {
    this.applyingRemote = true;
    if (this.echoTimer) clearTimeout(this.echoTimer);
    this.echoTimer = setTimeout(() => {
      this.applyingRemote = false;
    }, this.echoWindow);
  }

  /** §1.4 漂移校正（三档） */
  private checkDrift(): void {
    if (this.adapter.getPaused()) return; // 暂停时不校正

    // 发送心跳同时携带当前时间，由对方回复后计算漂移
    // 简化实现：直接用最近一次远端 state 的 sentAt 推算
    // 完整实现需要对方回复当前 time，这里通过 heartbeat 交换
    this.sendHeartbeat();
  }

  /**
   * 外部调用：收到对方心跳回复后，计算漂移并校正
   * @param remoteTime 对方当前播放时间
   * @param remotePaused 对方是否暂停
   * @param remoteSentAt 对方发送心跳时的统一时间
   */
  applyDriftCorrection(remoteTime: number, remotePaused: boolean, remoteSentAt: number): void {
    if (this.adapter.getPaused() || remotePaused) return;

    const elapsed = (this.clock.now() - remoteSentAt) / 1000;
    const expectedRemoteTime = remoteTime + elapsed * this.adapter.getRate();
    const localTime = this.adapter.getTime();
    const drift = localTime - expectedRemoteTime; // 正 = 本地领先

    const absDrift = Math.abs(drift);

    if (absDrift < this.driftIgnore) {
      // 忽略
      if (this.chasing) {
        this.chasing = false;
        this.adapter.setRate(1);
      }
      return;
    }

    if (absDrift <= this.driftRate) {
      // 变速追赶（§1.4 中档）
      this.chasing = true;
      // 本地落后（drift < 0）→ 加速；本地领先（drift > 0）→ 减速
      this.adapter.setRate(drift < 0 ? 1.05 : 0.95);
      return;
    }

    // >2s 直接 seek（§1.4 大档）
    this.chasing = false;
    this.adapter.setRate(1);
    this.setApplyingRemote();
    this.adapter.seek(expectedRemoteTime);
  }
}
