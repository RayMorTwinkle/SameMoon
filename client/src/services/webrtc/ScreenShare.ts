/**
 * ScreenShareService — 屏幕分享完整流程
 * 管理 getDisplayMedia → PeerConnectionManager → track 传输的生命周期
 */

import { PeerConnectionManager, type SignalingAdapter } from './PeerConnectionManager';
import { PCStatsCollector } from './PCStatsCollector';
import { screenShareStore } from './screenShareStore';
import { debugStore } from '../debugStore';

export type ScreenShareState = 'idle' | 'requesting' | 'running' | 'error';

export class ScreenShareService {
  private pcm: PeerConnectionManager | null = null;
  private collector: PCStatsCollector | null = null;
  private localStream: MediaStream | null = null;
  private onStateChange?: (s: ScreenShareState) => void;

  // ─── 分享方：开始分享 ───────────────────────────────

  async startSharing(signaling: SignalingAdapter): Promise<MediaStream> {
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

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      console.log('[SS-A] 用户通过浏览器 UI 停止分享');
      this.notifyState('idle');
    });

    this.pcm = new PeerConnectionManager(signaling);
    console.log('[SS-A] PCM 创建, 开始 initialize...');
    await this.pcm.initialize();
    console.log('[SS-A] PCM initialize 完成');

    for (const track of stream.getTracks()) {
      this.pcm.addTrack(track, stream);
    }
    console.log('[SS-A] 已添加', stream.getTracks().length, '个 track');

    console.log('[SS-A] 开始 createOffer...');
    await this.pcm.createOffer();
    console.log('[SS-A] createOffer 完成, offer 已发送');

    this.collector = new PCStatsCollector(this.pcm);
    this.collector.start((snapshot) => debugStore.setRtcStats(snapshot));

    screenShareStore.setSharing(stream, this.pcm, this.collector);
    console.log('[SS-A] setSharing 完成, store.pcm =', !!screenShareStore.state.pcm);

    this.notifyState('running');
    return stream;
  }

  // ─── 观看方：接受分享（offerSdp 为已收到的远端 offer） ──

  async startViewing(signaling: SignalingAdapter, offerSdp?: string): Promise<MediaStream> {
    console.log('[SS-B] startViewing: PCM 创建...');
    this.notifyState('requesting');

    this.pcm = new PeerConnectionManager(signaling);
    await this.pcm.initialize();
    console.log('[SS-B] PCM initialize 完成');

    screenShareStore.setPendingPCM(this.pcm);
    console.log('[SS-B] setPendingPCM 完成, store.pcm =', !!screenShareStore.state.pcm);

    // ★ 关键：必须在 receiveOffer 之前设置 track handler
    // 因为 receiveOffer 内部的 setRemoteDescription 会立即触发 ontrack
    let resolved = false;
    let trackResolve!: (stream: MediaStream) => void;
    const trackPromise = new Promise<MediaStream>((resolve) => {
      trackResolve = resolve;
    });
    this.pcm!.setTrackHandler((remoteStream) => {
      if (!resolved) { resolved = true; console.log('[SS-B] track 到达!'); trackResolve(remoteStream); }
    });

    if (offerSdp) {
      console.log('[SS-B] receiveOffer, SDP 长度:', offerSdp.length);
      await this.pcm.receiveOffer(offerSdp);
      console.log('[SS-B] receiveOffer 完成, answer 已发送');
    }

    console.log('[SS-B] 等待 track (30s 超时)...');
    const stream = await Promise.race([
      trackPromise,
      new Promise<MediaStream>((resolve) => {
        setTimeout(() => {
          if (!resolved) { resolved = true; console.log('[SS-B] track 超时!'); resolve(new MediaStream()); }
        }, 30000);
      }),
    ]);

    if (stream.getVideoTracks().length === 0) {
      console.error('[SS-B] 无 track, 清理');
      this.collector?.stop();
      this.pcm?.close();
      this.pcm = null;
      screenShareStore.reset();
      throw new Error('TRACK_TIMEOUT');
    }

    this.collector = new PCStatsCollector(this.pcm);
    this.collector.start((snapshot) => debugStore.setRtcStats(snapshot));

    screenShareStore.setViewing(stream, this.pcm, this.collector);
    console.log('[SS-B] setViewing 完成');
    this.notifyState('running');
    return stream;
  }

  // ─── 停止 ──────────────────────────────────────────

  stop(): void {
    this.collector?.stop();
    this.pcm?.close();
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.collector = null;
    this.pcm = null;
    screenShareStore.reset();
    debugStore.setRtcStats(null);
    this.notifyState('idle');
  }

  // ─── 连接状态 ──────────────────────────────────────

  getConnectionState(): RTCPeerConnectionState {
    return this.pcm?.connectionState ?? 'new';
  }

  getPCM(): PeerConnectionManager | null {
    return this.pcm;
  }

  // ─── 内部 ──────────────────────────────────────────

  private notifyState(s: ScreenShareState) {
    this.onStateChange?.(s);
  }

  onStateChangeHandler(cb: (s: ScreenShareState) => void) {
    this.onStateChange = cb;
  }
}
