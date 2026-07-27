/**
 * 时钟校准模块（NTP 式）
 * 见 TECH-SPEC §1.2
 */

export interface ClockSample {
  offset: number; // 对方时钟 - 本地时钟（ms）
  rtt: number;    // 往返时间（ms）
}

export class ClockSync {
  private samples: ClockSample[] = [];
  private readonly maxSamples = 10;

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

  /** 获取当前校准后的"统一时间"（用于消息 sentAt 字段） */
  now(): number {
    return Date.now() + this.getOffset();
  }

  /** 是否已有足够样本（≥3） */
  get isReady(): boolean {
    return this.samples.length >= 3;
  }

  reset(): void {
    this.samples = [];
  }
}
