/**
 * 时钟校准模块（NTP 式）
 * 见 TECH-SPEC §1.2
 */

export interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval>): void;
}

/** 真实时钟（生产用） */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
    return setTimeout(cb, ms);
  }
  clearTimeout(id: ReturnType<typeof setTimeout>): void {
    clearTimeout(id);
  }
  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval> {
    return setInterval(cb, ms);
  }
  clearInterval(id: ReturnType<typeof setInterval>): void {
    clearInterval(id);
  }
}

export interface ClockSample {
  offset: number; // 对方时钟 - 本地时钟（ms）
  rtt: number;    // 往返时间（ms）
}

export class ClockSync implements Clock {
  private samples: ClockSample[] = [];
  private readonly maxSamples = 10;
  private readonly clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  /** 记录一次采样结果 */
  addSample(t0: number, t1: number, t2: number, t3: number): void {
    const offset = ((t1 - t0) + (t2 - t3)) / 2;
    const rtt = (t3 - t0) - (t2 - t1);
    this.samples.push({ offset, rtt });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * 获取当前时钟偏移估计值（ms）
   * 取 rtt 最小的 3 个样本的 offset 中位数
   */
  getOffset(): number {
    if (this.samples.length === 0) return 0;

    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.min(3, sorted.length));
    const offsets = best.map(s => s.offset).sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)];
  }

  /** 将对方时间戳转换为本地时间表示 */
  toLocalTime(remoteTimestamp: number): number {
    return remoteTimestamp - this.getOffset();
  }

  /** 获取当前校准后的"统一时间"（≈对方原始时钟） */
  now(): number {
    return this.clock.now() + this.getOffset();
  }

  /**
   * 原始本地时钟（不加 offset）。
   * 协议约定：消息中的时间戳一律为发送方原始时钟，接收方用校准后 now()
   * （≈对方原始时钟）与之比较。NTP 采样必须用原始时钟，避免校准结果
   * 反馈进采样池造成 offset 振荡（Fix P1-5）。
   */
  rawNow(): number {
    return this.clock.now();
  }

  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
    return this.clock.setTimeout(cb, ms);
  }

  clearTimeout(id: ReturnType<typeof setTimeout>): void {
    this.clock.clearTimeout(id);
  }

  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval> {
    return this.clock.setInterval(cb, ms);
  }

  clearInterval(id: ReturnType<typeof setInterval>): void {
    this.clock.clearInterval(id);
  }

  /** 是否已有足够样本（≥3） */
  get isReady(): boolean {
    return this.samples.length >= 3;
  }

  reset(): void {
    this.samples = [];
  }
}
