/**
 * WebrtcStreamAdapter — 屏幕分享观看方的 PlaybackAdapter
 * 纯跟随模式：无 seek/rate 控制，仅播放/暂停本地 <video>
 */

import type { PlaybackAdapter, AdapterEvent, PlaybackSource } from './PlaybackAdapter';

export class WebrtcStreamAdapter implements PlaybackAdapter {
  private video: HTMLVideoElement | null = null;
  private listeners = new Map<AdapterEvent, Set<(detail?: unknown) => void>>();
  private eventUnsubs: (() => void)[] = [];
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async load(source: PlaybackSource): Promise<void> {
    if (source.kind !== 'webrtc-stream') {
      throw new Error('WebrtcStreamAdapter requires webrtc-stream source');
    }

    // 创建 video 元素
    this.video = document.createElement('video');
    this.video.style.width = '100%';
    this.video.style.height = '100%';
    this.video.style.objectFit = 'contain';
    this.video.style.background = '#000';
    this.video.muted = false;
    this.video.srcObject = source.stream;

    // 清空容器并挂载
    this.container.innerHTML = '';
    this.container.appendChild(this.video);

    // 挂接事件
    const onPlay = () => this.emit('play');
    const onPause = () => this.emit('pause');
    const onEnded = () => this.emit('ended');
    const onError = () => this.emit('error', { message: 'Stream error' });

    this.video.addEventListener('play', onPlay);
    this.video.addEventListener('pause', onPause);
    this.video.addEventListener('ended', onEnded);
    this.video.addEventListener('error', onError);

    this.eventUnsubs = [
      () => { this.video?.removeEventListener('play', onPlay); },
      () => { this.video?.removeEventListener('pause', onPause); },
      () => { this.video?.removeEventListener('ended', onEnded); },
      () => { this.video?.removeEventListener('error', onError); },
    ];

    // 等待流元数据加载
    await new Promise<void>((resolve) => {
      if (!this.video) { resolve(); return; }
      const onMeta = () => { this.video?.removeEventListener('loadedmetadata', onMeta); resolve(); };
      this.video.addEventListener('loadedmetadata', onMeta);
      setTimeout(resolve, 3000);
    });
  }

  async play(): Promise<void> {
    if (!this.video) return;
    return this.video.play();
  }

  pause(): void {
    this.video?.pause();
  }

  seek(): void {
    // 直播流不支持 seek
  }

  setRate(rate: number): void {
    if (this.video) this.video.playbackRate = rate;
  }

  getTime(): number {
    return this.video?.currentTime ?? 0;
  }

  getPaused(): boolean {
    return this.video?.paused ?? true;
  }

  getRate(): number {
    return this.video?.playbackRate ?? 1;
  }

  on(evt: AdapterEvent, cb: (detail?: unknown) => void): () => void {
    if (!this.listeners.has(evt)) {
      this.listeners.set(evt, new Set());
    }
    this.listeners.get(evt)!.add(cb);
    return () => this.listeners.get(evt)?.delete(cb);
  }

  destroy(): void {
    this.eventUnsubs.forEach(fn => fn());
    this.eventUnsubs = [];
    this.listeners.clear();
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
  }

  private emit(evt: AdapterEvent, detail?: unknown): void {
    this.listeners.get(evt)?.forEach(cb => cb(detail));
  }
}
