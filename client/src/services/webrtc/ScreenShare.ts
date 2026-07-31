/**
 * ScreenShareService — 屏幕分享完整流程
 * 基于 simple-peer，不再手搓 RTCPeerConnection
 */

import Peer from 'simple-peer';
import { PCStatsCollector } from './PCStatsCollector';
import { screenShareStore } from './screenShareStore';
import { debugStore, summarizeIceServers } from '../debugStore';

export type ScreenShareState = 'idle' | 'requesting' | 'running' | 'error';

/** 画质档位：编码码率上限 + 采集分辨率 + 帧率 */
export type QualityPreset = 'smooth' | 'balanced' | 'high' | 'ultra';

export const QUALITY_LABELS: Record<QualityPreset, string> = {
  smooth: '流畅',
  balanced: '标准',
  high: '高清',
  ultra: '极致',
};

const QUALITY_PRESETS: Record<QualityPreset, { maxBitrate: number; height: number; frameRate: number }> = {
  smooth:   { maxBitrate: 2_000_000,  height: 720,  frameRate: 30 },
  balanced: { maxBitrate: 5_000_000,  height: 1080, frameRate: 30 },
  high:     { maxBitrate: 10_000_000, height: 1080, frameRate: 60 },
  ultra:    { maxBitrate: 20_000_000, height: 2160, frameRate: 60 },
};

export class ScreenShareService {
  private peer: Peer.Instance | null = null;
  private collector: PCStatsCollector | null = null;
  private localStream: MediaStream | null = null;
  private onStateChange?: (s: ScreenShareState) => void;
  /** peer 创建前到达的信令缓冲（修复 trickle ICE 竞态：offer 处理期间 candidate 不再丢失/误触发新 peer） */
  private pendingSignals: unknown[] = [];

  /** 统一信令入口：peer 未创建时先入队，创建后由 flushPendingSignals 排空 */
  signal(data: unknown): void {
    if (this.peer && !(this.peer as any).destroyed) {
      this.peer.signal(data as Peer.SignalData);
    } else if (!this.peer) {
      this.pendingSignals.push(data);
    } else {
      debugStore.logError('rtc', 'signal-after-destroy', (data as { type?: string })?.type ?? 'candidate');
    }
  }

  private flushPendingSignals(): void {
    if (!this.peer) return;
    for (const s of this.pendingSignals) {
      this.peer.signal(s as Peer.SignalData);
    }
    this.pendingSignals = [];
  }

  // ─── 分享方：开始分享 ───────────────────────────────

  async startSharing(sendSignal: (data: unknown) => void): Promise<MediaStream> {
    console.log('[SS-A] startSharing: 调用 getDisplayMedia...');
    this.notifyState('requesting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: true,
      });
      console.log('[SS-A] getDisplayMedia 成功, tracks:', stream.getTracks().length);
    } catch (err) {
      console.error('[SS-A] getDisplayMedia 失败:', err);
      this.notifyState('error');
      throw err;
    }
    this.localStream = stream;
    // 内容提示：电影/视频画面优先运动流畅度，音频按音乐优化编码（默认按文本/语音优化，画质音质都会受损）
    const vTrack = stream.getVideoTracks()[0];
    if (vTrack) vTrack.contentHint = 'motion';
    const aTrack = stream.getAudioTracks()[0];
    if (aTrack) aTrack.contentHint = 'music';

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      console.log('[SS-A] 用户通过浏览器 UI 停止分享');
      this.notifyState('idle');
    });

    const config = await this.getRtcConfig();
    this.peer = new Peer({ initiator: true, stream, config });

    this.peer.on('signal', data => {
      console.log('[SS-A] signal 产生, type =', (data as any)?.type, 'hasSdp =', !!(data as any)?.sdp);
      sendSignal(data);
    });
    this.peer.on('error', err => {
      console.error('[SS-A] peer error:', err);
      debugStore.logError('rtc', 'sharer-peer-error', err.message);
    });
    this.peer.on('connect', () => {
      console.log('[SS-A] DataChannel 已连接, ICE 协商完成');
      debugStore.log('rtc', 'connected', 'sharer');
      // 连接建立后应用默认质量（浏览器默认码率上限仅 ~2.5Mbps 且爬升缓慢）
      void this.setVideoQuality('balanced');
      void this.setAudioBitrate(128_000);
    });
    (this.peer as any).on('iceStateChange', (ice: string, gathering: string) => {
      debugStore.log('rtc', 'ice-state', `sharer: ${ice} / gathering=${gathering}`);
    });
    this.flushPendingSignals();

    console.log('[SS-A] peer 创建完成, 等待对方 answer...');

    this.collector = new PCStatsCollector(this.peer);
    this.collector.start((snapshot) => debugStore.setRtcStats(snapshot));

    screenShareStore.setSharing(stream, this.peer, this.collector);
    console.log('[SS-A] setSharing 完成, store.peer =', !!screenShareStore.state.peer);

    this.notifyState('running');
    return stream;
  }

  // ─── 观看方：接受分享 ───────────────────────────────

  async startViewing(
    sendSignal: (data: unknown) => void,
    existingSignal?: unknown,
  ): Promise<MediaStream> {
    console.log('[SS-B] startViewing: 创建 peer...');
    this.notifyState('requesting');

    const config = await this.getRtcConfig();
    this.peer = new Peer({
      initiator: false,
      config,
      // 观看方在 answer 中声明 opus 立体声 + 256kbps（发送方编码依接收方 SDP 声明，
      // 默认单声道 ~32kbps 语音档，看电影音质很差）
      sdpTransform: (sdp: string) =>
        sdp.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000'),
    });

    this.peer.on('signal', data => {
      console.log('[SS-B] signal 产生, type =', (data as any)?.type, 'hasSdp =', !!(data as any)?.sdp);
      sendSignal(data);
    });
    this.peer.on('error', err => {
      console.error('[SS-B] peer error:', err);
      debugStore.logError('rtc', 'viewer-peer-error', err.message);
    });
    this.peer.on('connect', () => {
      console.log('[SS-B] DataChannel 已连接, ICE 协商完成');
      debugStore.log('rtc', 'connected', 'viewer');
    });
    (this.peer as any).on('iceStateChange', (ice: string, gathering: string) => {
      debugStore.log('rtc', 'ice-state', `viewer: ${ice} / gathering=${gathering}`);
    });

    screenShareStore.setPendingPeer(this.peer);
    console.log('[SS-B] setPendingPeer 完成, store.peer =', !!screenShareStore.state.peer);

    // ★ simple-peer 内部处理所有时序，无需 ICE 缓冲
    console.log('[SS-B] 等待 track (10s 超时)...');
    const streamPromise = new Promise<MediaStream>((resolve, reject) => {
      this.peer!.on('stream', (remoteStream) => {
        console.log('[SS-B] stream 到达!');
        resolve(remoteStream);
      });
      this.peer!.on('error', reject);
      setTimeout(() => reject(new Error('TRACK_TIMEOUT')), 10000);
    });

    if (existingSignal) {
      console.log('[SS-B] 传入已有 signal (offer), 调用 peer.signal()...');
      this.peer.signal(existingSignal as Peer.SignalData);
    }
    // 排空 offer 处理期间到达的 candidate（顺序保持在 offer 之后）
    this.flushPendingSignals();

    let stream: MediaStream;
    try {
      stream = await streamPromise;
    } catch (err) {
      console.error('[SS-B] startViewing 失败:', err);
      this.collector?.stop();
      this.peer?.destroy();
      this.peer = null;
      screenShareStore.reset();
      throw err;
    }

    if (stream.getVideoTracks().length === 0) {
      console.error('[SS-B] 无 track, 清理');
      this.collector?.stop();
      this.peer?.destroy();
      this.peer = null;
      screenShareStore.reset();
      throw new Error('TRACK_TIMEOUT');
    }

    this.collector = new PCStatsCollector(this.peer);
    this.collector.start((snapshot) => debugStore.setRtcStats(snapshot));

    screenShareStore.setViewing(stream, this.peer, this.collector);
    console.log('[SS-B] setViewing 完成');
    this.notifyState('running');
    return stream;
  }

  // ─── 停止 ──────────────────────────────────────────

  // ─── 质量控制（分享方运行时可调） ──────────────────

  async setVideoQuality(preset: QualityPreset): Promise<void> {
    const cfg = QUALITY_PRESETS[preset];
    const sender = this.getSender('video');
    if (sender) {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = cfg.maxBitrate;
      // 电影画面优先保分辨率（模糊比掉帧更影响观感）
      (params as { degradationPreference?: string }).degradationPreference = 'maintain-resolution';
      try {
        await sender.setParameters(params);
      } catch (e) {
        debugStore.logError('rtc', 'set-video-params-failed', (e as Error).message);
      }
    }
    const track = this.localStream?.getVideoTracks()[0];
    try {
      await track?.applyConstraints({ height: { ideal: cfg.height }, frameRate: { ideal: cfg.frameRate } });
    } catch { /* 部分浏览器不支持运行时变更采集约束，忽略 */ }
    debugStore.log('rtc', 'video-quality', preset);
  }

  async setFrameRate(fps: number): Promise<void> {
    const track = this.localStream?.getVideoTracks()[0];
    try {
      await track?.applyConstraints({ frameRate: { ideal: fps } });
    } catch { /* ignore */ }
    debugStore.log('rtc', 'frame-rate', fps);
  }

  async setAudioBitrate(bps: number): Promise<void> {
    const sender = this.getSender('audio');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = bps;
    try {
      await sender.setParameters(params);
    } catch (e) {
      debugStore.logError('rtc', 'set-audio-params-failed', (e as Error).message);
    }
    debugStore.log('rtc', 'audio-bitrate', bps);
  }

  private getSender(kind: 'video' | 'audio'): RTCRtpSender | null {
    const pc = (this.peer as any)?._pc as RTCPeerConnection | undefined;
    return pc?.getSenders().find(s => s.track?.kind === kind) ?? null;
  }

  stop(): void {
    this.collector?.stop();
    this.peer?.destroy();
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.collector = null;
    this.peer = null;
    screenShareStore.reset();
    debugStore.setRtcStats(null);
    this.notifyState('idle');
  }

  // ─── 连接状态 ──────────────────────────────────────

  getConnectionState(): RTCPeerConnectionState {
    const pc = (this.peer as any)?._pc as RTCPeerConnection | undefined;
    return pc?.connectionState ?? 'new';
  }

  getPeer(): Peer.Instance | null {
    return this.peer;
  }

  // ─── 内部 ──────────────────────────────────────────

  private async getRtcConfig(): Promise<RTCConfiguration> {
    try {
      const resp = await fetch('/api/ice-servers');
      const data = await resp.json();
      const servers = (data.iceServers as RTCIceServer[]) ?? [];
      debugStore.log('rtc', 'ice-config', summarizeIceServers(servers));
      return { iceServers: servers, iceTransportPolicy: 'all' };
    } catch {
      debugStore.logError('rtc', 'ice-config-fallback', '/api/ice-servers 请求失败，降级为 Google STUN');
      return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    }
  }

  private notifyState(s: ScreenShareState) {
    this.onStateChange?.(s);
  }

  onStateChangeHandler(cb: (s: ScreenShareState) => void) {
    this.onStateChange = cb;
  }
}
