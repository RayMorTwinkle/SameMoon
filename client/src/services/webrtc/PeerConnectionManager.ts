/**
 * PeerConnectionManager — RTCPeerConnection 封装
 * 管理 ICE 协商、DataChannel 和媒体轨道
 * 通过回调适配器与 WS 信令解耦
 */

import type {
  TimelineEvent, ConnectionRoute,
} from './types';

/** 信令适配器：上层通过此接口与 WS 层交互 */
export interface SignalingAdapter {
  sendRtcOffer(data: { sdp: string }): void;
  sendRtcAnswer(data: { sdp: string }): void;
  sendRtcIce(data: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }): void;
  onRtcOffer?: (data: { sdp: string; from: string }) => void;
  onRtcAnswer?: (data: { sdp: string; from: string }) => void;
  onRtcIce?: (data: { candidate: string; sdpMid?: string; sdpMLineIndex?: number; from: string }) => void;
}

export type ConnectionStateCallback = (state: RTCPeerConnectionState) => void;
export type DataChannelCallback = (channel: RTCDataChannel) => void;
export type TrackCallback = (stream: MediaStream) => void;
export type TimelineCallback = (event: TimelineEvent) => void;

export class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private signaling: SignalingAdapter;
  private iceServers: RTCIceServer[] | null = null;

  private onConnectionStateChange?: ConnectionStateCallback;
  private onDataChannel?: DataChannelCallback;
  private onTrack?: TrackCallback;
  private onTimeline?: TimelineCallback;

  // 创建的 DataChannel 索引
  private dataChannels = new Map<string, RTCDataChannel>();

  constructor(signaling: SignalingAdapter) {
    this.signaling = signaling;
  }

  /** 设置 ICE 服务器列表（从 /api/ice-servers 获取） */
  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers;
  }

  // ─── 事件回调 ───────────────────────────────────────

  setConnectionStateHandler(cb: ConnectionStateCallback): void {
    this.onConnectionStateChange = cb;
  }

  setDataChannelHandler(cb: DataChannelCallback): void {
    this.onDataChannel = cb;
    // 已有通道也立即通知
    for (const dc of this.dataChannels.values()) {
      cb(dc);
    }
  }

  setTrackHandler(cb: TrackCallback): void {
    this.onTrack = cb;
  }

  setTimelineHandler(cb: TimelineCallback): void {
    this.onTimeline = cb;
  }

  // ─── 连接生命周期 ───────────────────────────────────

  /** 创建 RTCPeerConnection（先获取 iceServers） */
  async initialize(): Promise<RTCPeerConnection> {
    if (!this.iceServers) {
      try {
        const resp = await fetch('/api/ice-servers');
        const data = await resp.json();
        if (data.iceServers) {
          this.iceServers = data.iceServers as RTCIceServer[];
        }
      } catch {
        // 降级：使用公共 STUN
        this.iceServers = [
          { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
        ];
      }
    }

    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers ?? undefined,
      iceTransportPolicy: 'all',
    });

    // 连接状态变化
    this.pc.onconnectionstatechange = () => {
      const state = this.pc!.connectionState;
      console.log('[PCM] connectionState →', state);
      this.onConnectionStateChange?.(state);
      this.logTimeline('ice-state', `ICE ${state}`);
    };

    // ICE 收集状态
    this.pc.onicegatheringstatechange = () => {
      this.logTimeline('gathering', `ICE gathering: ${this.pc!.iceGatheringState}`);
    };

    // ICE 候选
    this.pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        console.log('[PCM] ICE candidate 产生:', evt.candidate.type, evt.candidate.address);
        this.signaling.sendRtcIce({
          candidate: evt.candidate.candidate,
          sdpMid: evt.candidate.sdpMid ?? undefined,
          sdpMLineIndex: evt.candidate.sdpMLineIndex ?? undefined,
        });
      } else {
        console.log('[PCM] ICE gathering 完成');
      }
    };

    // ICE 连接状态变化（合并：日志 + selected pair + 上层通知）
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc!.iceConnectionState;
      console.log('[PCM] iceConnectionState →', state);
      if (state === 'connected' || state === 'completed') {
        this.logSelectedPair();
      }
      this.onConnectionStateChange?.(this.pc!.connectionState);
    };

    // 远端 DataChannel（被动接收方）
    this.pc.ondatachannel = (evt) => {
      const dc = evt.channel;
      this.setupDataChannel(dc);
    };

    // 远端 track（屏幕分享观看方）
    this.pc.ontrack = (evt) => {
      const stream = evt.streams[0];
      if (stream) {
        console.log('[PCM] ontrack 触发, kind:', evt.track.kind, 'streams:', evt.streams.length);
        this.logTimeline('track-added', `Track received: ${evt.track.kind}`);
        this.onTrack?.(stream);
      }
    };

    // 为适配器挂接信令回调
    this.signaling.onRtcOffer = (data: { sdp: string; from: string }) => {
      if (!this.pc) return;
      this.logTimeline('signal', `Received offer from ${data.from}`);
      this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }))
        .then(() => this.pc!.createAnswer())
        .then((answer) => {
          this.pc!.setLocalDescription(answer);
          this.signaling.sendRtcAnswer({ sdp: answer.sdp ?? '' });
        })
        .catch(console.error);
    };

    this.signaling.onRtcAnswer = (data: { sdp: string; from: string }) => {
      if (!this.pc) return;
      this.logTimeline('signal', `Received answer from ${data.from}`);
      this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }))
        .catch(console.error);
    };

    this.signaling.onRtcIce = (data: { candidate: string; sdpMid?: string; sdpMLineIndex?: number; from: string }) => {
      if (!this.pc) return;
      this.logTimeline('signal', `Received ICE from ${data.from}`);
      this.pc.addIceCandidate(new RTCIceCandidate({
        candidate: data.candidate,
        sdpMid: data.sdpMid,
        sdpMLineIndex: data.sdpMLineIndex,
      })).catch(console.error);
    };

    return this.pc;
  }

  // ─── 主动创建 DataChannel ────────────────────────────

  createDataChannel(label: string): RTCDataChannel {
    if (!this.pc) throw new Error('PC not initialized');
    const dc = this.pc.createDataChannel(label);
    this.setupDataChannel(dc);
    return dc;
  }

  // ─── 添加媒体轨道（屏幕分享） ─────────────────────────

  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender | null {
    if (!this.pc) return null;
    return this.pc.addTrack(track, stream);
  }

  removeTrack(sender: RTCRtpSender): void {
    this.pc?.removeTrack(sender);
  }

  // ─── 发起连接 ────────────────────────────────────────

  async createOffer(): Promise<void> {
    if (!this.pc) throw new Error('PC not initialized');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    console.log('[PCM] createOffer: SDP 长度 =', offer.sdp?.length, '字节');
    this.signaling.sendRtcOffer({ sdp: offer.sdp ?? '' });
    console.log('[PCM] offer 已通过 WS 发送');
  }

  // ─── 公开方法：外部传入 offer（用于已收到的 offer 而 PCM 后创建的场景） ──

  async receiveOffer(sdp: string): Promise<void> {
    if (!this.pc) throw new Error('PC not initialized');
    this.logTimeline('signal', 'Processing received offer');
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.sendRtcAnswer({ sdp: answer.sdp ?? '' });
  }

  /** 接收远端 answer */
  async receiveAnswer(sdp: string): Promise<void> {
    if (!this.pc) return;
    // 如果已是 stable 状态（重复 answer），忽略
    if (this.pc.signalingState === 'stable') {
      console.log('[PCM] receiveAnswer: 已是 stable 状态，忽略重复 answer');
      return;
    }
    console.log('[PCM] receiveAnswer: 设置远端 answer, SDP 长度:', sdp.length);
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      console.log('[PCM] 远端 answer 设置成功, signalingState =', this.pc.signalingState);
    } catch (err) {
      console.error('[PCM] setRemoteDescription(answer) 失败:', err);
    }
  }

  /** 接收远端 ICE candidate */
  async receiveIce(candidate: string, sdpMid?: string, sdpMLineIndex?: number): Promise<void> {
    if (!this.pc) return;
    const type = candidate.match(/typ\s+(\w+)/)?.[1] ?? 'unknown';
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate({ candidate, sdpMid, sdpMLineIndex }));
      console.log('[PCM] 远端 ICE 候选添加成功:', type);
    } catch (err) {
      console.error('[PCM] addIceCandidate 失败:', type, err);
    }
  }

  // ─── 连接分析 ────────────────────────────────────────

  /** 获取当前使用的路由类型 */
  getRoute(): ConnectionRoute {
    if (!this.pc) return 'unknown';
    const state = this.pc.iceConnectionState;
    if (state !== 'connected' && state !== 'completed') return 'unknown';
    // 通过 getStats 获取选中候选对（简化：检查最近 ICE 候选类型）
    // 实际由 PCStatsCollector 提供精确数据
    return 'unknown';
  }

  /** 获取底层 RTCPeerConnection（供 PCStatsCollector 使用） */
  getPeerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  /** 获取所有 DataChannel */
  getDataChannels(): RTCDataChannel[] {
    return [...this.dataChannels.values()];
  }

  /** 获取 ICE 连接状态 */
  get iceConnectionState(): RTCIceConnectionState {
    return this.pc?.iceConnectionState ?? 'new';
  }

  /** 获取 ICE 收集状态 */
  get iceGatheringState(): RTCIceGatheringState {
    return this.pc?.iceGatheringState ?? 'new';
  }

  /** 获取连接状态 */
  get connectionState(): RTCPeerConnectionState {
    return this.pc?.connectionState ?? 'new';
  }

  // ─── 清理 ────────────────────────────────────────────

  close(): void {
    this.dataChannels.clear();
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  // ─── 内部 ────────────────────────────────────────────

  private setupDataChannel(dc: RTCDataChannel): void {
    this.dataChannels.set(dc.label, dc);
    dc.onopen = () => {
      this.logTimeline('dc-open', `DataChannel ${dc.label} open`);
      this.onDataChannel?.(dc);
    };
    dc.onclose = () => {
      this.logTimeline('dc-close', `DataChannel ${dc.label} closed`);
      this.dataChannels.delete(dc.label);
    };
    dc.onerror = () => {
      this.logTimeline('error', `DataChannel ${dc.label} error`);
    };
    // 如果已经 open（主动创建时可能已经 open）
    if (dc.readyState === 'open') {
      this.onDataChannel?.(dc);
    }
  }

  private logTimeline(type: TimelineEvent['type'], detail: string): void {
    this.onTimeline?.({ ts: Date.now(), type, detail });
  }

  /** 异步获取选中的 ICE 候选对 */
  private async logSelectedPair(): Promise<void> {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      for (const report of stats.values()) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const local = stats.get(report.localCandidateId);
          const remote = stats.get(report.remoteCandidateId);
          if (local && remote) {
            const lt = (local as { candidateType?: string }).candidateType ?? 'unknown';
            const rt = (remote as { candidateType?: string }).candidateType ?? 'unknown';
            this.logTimeline('pair-selected',
              `Pair: ${lt} ↔ ${rt} (${(remote as { address?: string }).address ?? '?'})`);
          }
        }
      }
    } catch {
      // getStats 可能不可用
    }
  }
}
