/**
 * PlaybackAdapter 接口定义
 * SyncEngine 只依赖此接口，绝不直接 import ArtPlayer/YT。
 * 见 TECH-SPEC §4
 */

export type AdapterEvent =
  | 'play'
  | 'pause'
  | 'seeked'
  | 'ratechange'
  | 'waiting'
  | 'canplay'
  | 'error'
  | 'ended';

export type PlaybackSource =
  | { kind: 'local-file'; file: File }
  | { kind: 'direct-url'; url: string }
  | { kind: 'webrtc-stream'; stream: MediaStream }
  | { kind: 'youtube'; videoId: string };

export interface PlaybackAdapter {
  /** 加载媒体源 */
  load(source: PlaybackSource): Promise<void>;
  /** 播放（必须透传 play() 的 rejection，用于自动播放策略处理） */
  play(): Promise<void>;
  /** 暂停 */
  pause(): void;
  /** 跳转到指定时间（秒） */
  seek(time: number): void;
  /** 设置倍速 */
  setRate(rate: number): void;
  /** 获取当前播放时间（秒） */
  getTime(): number;
  /** 获取是否暂停 */
  getPaused(): boolean;
  /** 获取当前倍速 */
  getRate(): number;
  /** 订阅事件，返回取消函数 */
  on(evt: AdapterEvent, cb: (detail?: unknown) => void): () => void;
  /** 销毁实例，释放资源 */
  destroy(): void;
}
