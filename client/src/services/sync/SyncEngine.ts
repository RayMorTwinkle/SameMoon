/**
 * 同步引擎核心
 * 见 TECH-SPEC §1.3-1.7
 * 与传输层解耦（§1.8）：不 import WebSocket/RTC
 */

import type { PlaybackAdapter } from '../playback/PlaybackAdapter';
import { ClockSync, type Clock } from './ClockSync';

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

/** SyncEngine 对外事件类型 */
export type SyncEngineEvent = 'synced' | 'drifting' | 'buffering' | 'buffering-timeout';

interface SyncEngineOptions {
  adapter: PlaybackAdapter;
  transport: SyncTransport;
  clockSync: ClockSync;
  userId: string;
  /** 内部事件回调（同步状态变化等本地事件，不走网络） */
  onEvent?: (evt: SyncEngineEvent, detail?: Record<string, unknown>) => void;
  /** 漂移校正阈值（秒），可测试时注入 */
  driftIgnoreThreshold?: number;   // 默认 0.3
  driftRateThreshold?: number;     // 默认 2.0
  /** 回声抑制排空窗口（ms） */
  echoWindow?: number;             // 默认 150
  /** 时钟（测试注入） */
  clock?: Clock;
}

export class SyncEngine {
  private adapter: PlaybackAdapter;
  private transport: SyncTransport;
  private clockSync: ClockSync;
  private timerClock: Clock;
  private userId: string;
  private onEvent?: (evt: SyncEngineEvent, detail?: Record<string, unknown>) => void;

  private seq = 0;
  private applyingRemote = false;
  private echoTimer: ReturnType<typeof setTimeout> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private bufferingTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: Array<() => void> = [];

  private readonly driftIgnore: number;
  private readonly driftRate: number;
  private readonly echoWindow: number;

  // 变速追赶状态
  private chasing = false;

  private static readonly BUFFERING_TIMEOUT_MS = 30_000;

  constructor(opts: SyncEngineOptions) {
    this.adapter = opts.adapter;
    this.transport = opts.transport;
    this.clockSync = opts.clockSync;
    this.timerClock = opts.clock ?? opts.clockSync;
    this.userId = opts.userId;
    this.onEvent = opts.onEvent;
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
    this.driftTimer = this.timerClock.setInterval(() => this.checkDrift(), 5000);
  }

  /** 停止：清理所有监听和定时器 */
  stop(): void {
    this.unsubscribers.forEach(fn => fn());
    this.unsubscribers = [];
    if (this.driftTimer) this.timerClock.clearInterval(this.driftTimer);
    if (this.echoTimer) this.timerClock.clearTimeout(this.echoTimer);
    if (this.bufferingTimer) this.timerClock.clearTimeout(this.bufferingTimer);
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
        // 区分请求/响应（Fix R2/R3）：无 seq = 请求，有 seq = 响应
        if (data.seq === undefined || data.seq === null) {
          // 对方请求我的状态 → 回复
          this.sendState();
        } else {
          const state = data as unknown as PlaybackState;
          this.seq = Math.max(this.seq, state.seq);
          this.applyRemote(state);
        }
        break;
      }
      case 'sync:buffering': {
        // 对方在缓冲 → 暂停等待（§1.6）
        this.setApplyingRemote();
        this.adapter.pause();
        this.onEvent?.('buffering');
        // 启动 30s 超时保护：超时后通知 UI 解除同步锁
        if (this.bufferingTimer) this.timerClock.clearTimeout(this.bufferingTimer);
        this.bufferingTimer = this.timerClock.setTimeout(() => {
          this.bufferingTimer = null;
          this.emitBufferingTimeout();
        }, SyncEngine.BUFFERING_TIMEOUT_MS);
        break;
      }
      case 'sync:ready': {
        // 对方就绪 → 对齐后恢复；同时取消缓冲超时
        if (this.bufferingTimer) {
          this.timerClock.clearTimeout(this.bufferingTimer);
          this.bufferingTimer = null;
        }
        const time = (data as { time: number }).time;
        this.setApplyingRemote();
        this.adapter.seek(time);
        this.adapter.play().catch(() => {});
        this.onEvent?.('synced');
        break;
      }
      case 'sync:heartbeat': {
        this.handleHeartbeat(data);
        break;
      }
    }
  }

  /** 请求对方发送全量状态（重连/迟到追齐） */
  requestState(): void {
    this.transport.send({ type: 'sync:state', data: {} });
  }

  /** 发送当前全量状态（响应 sync:state 请求，不递增 seq） */
  sendState(): void {
    this.transport.send({
      type: 'sync:state',
      data: this.snapshotState(),
    });
  }

  /** 发送心跳（携带时钟采样 + 当前播放状态，Fix B2+B3） */
  sendHeartbeat(): void {
    this.transport.send({
      type: 'sync:heartbeat',
      data: {
        clientTime: this.clockSync.now(),  // t0
        time: this.adapter.getTime(),
        paused: this.adapter.getPaused(),
        rate: this.adapter.getRate(),
      },
    });
  }

  // ─── 内部方法 ───────────────────────────────────────

  /** 捕获当前状态（用户操作触发，递增 seq） */
  private captureState(): PlaybackState {
    this.seq += 1;
    return {
      paused: this.adapter.getPaused(),
      time: this.adapter.getTime(),
      rate: this.adapter.getRate(),
      seq: this.seq,
      senderId: this.userId,
      sentAt: this.clockSync.now(),
    };
  }

  /** 快照当前状态（被动响应，不递增 seq，避免 sendState 错误膨胀 seq） */
  private snapshotState(): PlaybackState {
    return {
      paused: this.adapter.getPaused(),
      time: this.adapter.getTime(),
      rate: this.adapter.getRate(),
      seq: this.seq,
      senderId: this.userId,
      sentAt: this.clockSync.now(),
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
    const elapsed = (this.clockSync.now() - state.sentAt) / 1000;
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
    if (this.echoTimer) this.timerClock.clearTimeout(this.echoTimer);
    this.echoTimer = this.timerClock.setTimeout(() => {
      this.applyingRemote = false;
    }, this.echoWindow);
  }

  /** §1.4 漂移校正（三档） */
  private checkDrift(): void {
    if (this.adapter.getPaused()) return;
    this.sendHeartbeat();
  }

  /**
   * 心跳双向握手处理（Fix B2+B3）
   * 收到无 echoOf 的心跳 = 请求：回复 + 用对方状态做漂移校正
   * 收到有 echoOf 的心跳 = 响应：计算时钟偏移 + 用对方状态做漂移校正
   */
  private handleHeartbeat(data: Record<string, unknown>): void {
    const remoteTime = data.time as number | undefined;
    const remotePaused = data.paused as boolean | undefined;

    if (data.echoOf === undefined) {
      // 这是请求：记录 t1，回复带 echo
      const t1 = this.clockSync.now();
      const t0 = data.clientTime as number;
      this.transport.send({
        type: 'sync:heartbeat',
        data: {
          echoOf: t0,          // 回显对方 t0
          t1,                  // 我收到时刻
          clientTime: this.clockSync.now(), // t2（我发送时刻）
          time: this.adapter.getTime(),
          paused: this.adapter.getPaused(),
          rate: this.adapter.getRate(),
        },
      });
      // 用对方携带的状态做漂移校正（Fix N1：时钟未校准时跳过，避免误触发）
      if (this.clockSync.isReady
          && remoteTime !== undefined && remotePaused !== undefined) {
        this.applyDriftCorrection(remoteTime, remotePaused, t0);
      }
    } else {
      // 这是响应：计算时钟偏移
      const t0 = data.echoOf as number;
      const t1 = data.t1 as number;
      const t2 = data.clientTime as number;
      const t3 = this.clockSync.now();
      this.clockSync.addSample(t0, t1, t2, t3);
      // 用对方状态做漂移校正（Fix N1：时钟未校准时跳过，避免误触发）
      if (this.clockSync.isReady
          && remoteTime !== undefined && remotePaused !== undefined) {
        this.applyDriftCorrection(remoteTime, remotePaused, t2);
      }
    }
  }

  /**
   * 外部调用：收到对方心跳回复后，计算漂移并校正
   * @param remoteTime 对方当前播放时间
   * @param remotePaused 对方是否暂停
   * @param remoteSentAt 对方发送心跳时的统一时间
   */
  applyDriftCorrection(remoteTime: number, remotePaused: boolean, remoteSentAt: number): void {
    if (this.adapter.getPaused() || remotePaused) return;

    const elapsed = (this.clockSync.now() - remoteSentAt) / 1000;
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
      this.onEvent?.('synced');
      return;
    }

    if (absDrift <= this.driftRate) {
      // 变速追赶（§1.4 中档）
      this.chasing = true;
      // 本地落后（drift < 0）→ 加速；本地领先（drift > 0）→ 减速
      this.adapter.setRate(drift < 0 ? 1.05 : 0.95);
      this.onEvent?.('drifting');
      return;
    }

    // >2s 直接 seek（§1.4 大档）
    this.chasing = false;
    this.adapter.setRate(1);
    this.setApplyingRemote();
    this.adapter.seek(expectedRemoteTime);
    this.onEvent?.('drifting');
  }

  /** §1.6 缓冲超时：通知 UI 解除同步锁，让本地独立播放 */
  private emitBufferingTimeout(): void {
    this.onEvent?.('buffering-timeout', {
      message: '对方网络较差，你可以选择继续独立观看',
    });
  }
}
