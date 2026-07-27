import Artplayer from 'artplayer';
import type { PlaybackAdapter, PlaybackSource, AdapterEvent } from './PlaybackAdapter';

/**
 * 本地文件播放适配器（ArtPlayer 封装）
 * 见 TECH-SPEC §2
 */
export class LocalFileAdapter implements PlaybackAdapter {
  private art: Artplayer | null = null;
  private objectUrl: string | null = null;
  private listeners = new Map<AdapterEvent, Set<(detail?: unknown) => void>>();
  private container: HTMLElement;
  // 内部缓存的 paused 状态，解决 art.play() 异步导致事件触发时状态滞后问题
  private _paused = true;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async load(source: PlaybackSource): Promise<void> {
    if (source.kind !== 'local-file') {
      throw new Error('LocalFileAdapter only supports local-file source');
    }

    // 清理旧实例
    this.destroy();

    this.objectUrl = URL.createObjectURL(source.file);

    this.art = new Artplayer({
      container: this.container as string | HTMLDivElement,
      url: this.objectUrl,
      autoplay: false,
      autoSize: false,
      autoMini: true,
      loop: false,
      flip: false,
      playbackRate: true,
      fullscreen: true,
      fullscreenWeb: true,
      pip: true,
      theme: '#19c8b9',
    });

    // 挂接事件（见 TECH-SPEC §2.1）
    this.art.on('play', () => { this._paused = false; this.emit('play'); });
    this.art.on('pause', () => { this._paused = true; this.emit('pause'); });
    this.art.on('seek', () => this.emit('seeked'));
    this.art.on('video:ratechange', () => this.emit('ratechange'));
    this.art.on('video:waiting', () => this.emit('waiting'));
    this.art.on('video:canplay', () => this.emit('canplay'));
    this.art.on('video:error', () => this.emit('error'));
    this.art.on('video:ended', () => this.emit('ended'));
  }

  async play(): Promise<void> {
    // 立即更新内部状态，使事件触发时 getPaused() 返回正确值
    this._paused = false;
    // 透传 play() 的 rejection（自动播放策略，TECH-SPEC §2.4）
    await this.art?.play();
  }

  pause(): void {
    this._paused = true;
    this.art?.pause();
  }

  seek(time: number): void {
    if (this.art) {
      this.art.seek = time;
    }
  }

  setRate(rate: number): void {
    if (this.art) {
      this.art.playbackRate = rate;
    }
  }

  getTime(): number {
    return this.art?.currentTime ?? 0;
  }

  getPaused(): boolean {
    // 优先返回内部缓存（解决 art.play() 异步导致的状态滞后）
    // 如果 art 存在且状态矛盾，以 art 为准（远端施加的操作会更新 art）
    const artPaused = (this.art as unknown as { paused: boolean } | null)?.paused;
    if (artPaused !== undefined && artPaused !== this._paused) {
      // art 状态更新时同步内部缓存
      this._paused = artPaused;
    }
    return this._paused;
  }

  getRate(): number {
    return this.art?.playbackRate ?? 1;
  }

  on(evt: AdapterEvent, cb: (detail?: unknown) => void): () => void {
    if (!this.listeners.has(evt)) {
      this.listeners.set(evt, new Set());
    }
    this.listeners.get(evt)!.add(cb);
    return () => { this.listeners.get(evt)?.delete(cb); };
  }

  destroy(): void {
    if (this.art) {
      this.art.destroy(false); // false = 不移除 DOM 容器
      this.art = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.listeners.clear();
  }

  private emit(evt: AdapterEvent, detail?: unknown): void {
    this.listeners.get(evt)?.forEach(cb => cb(detail));
  }
}
