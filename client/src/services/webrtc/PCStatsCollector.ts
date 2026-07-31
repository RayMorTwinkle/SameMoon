/**
 * PCStatsCollector — WebRTC 统计信息采集器（simple-peer 适配）
 * 每 2s 从 peer._pc.getStats() 拉取数据
 * 供 DebugPanel 实时展示
 */

import type Peer from 'simple-peer';
import type {
  PCStatsSnapshot, CandidateInfo, SelectedPair, DataChannelInfo, TimelineEvent,
} from './types';

export class PCStatsCollector {
  private peer: Peer.Instance;
  private interval: ReturnType<typeof setInterval> | null = null;
  private timeline: TimelineEvent[] = [];
  private onUpdate?: (snapshot: PCStatsSnapshot) => void;

  private static readonly POLL_MS = 2000;
  private static readonly MAX_TIMELINE = 50;

  // 码率差分基线
  private lastBytesSent = 0;
  private lastBytesReceived = 0;
  private lastPollTs = 0;

  constructor(peer: Peer.Instance) {
    this.peer = peer;

    // 监听 peer 事件构建时间线
    peer.on('connect', () => this.recordTimeline('dc-open', 'DataChannel connected'));
    peer.on('close', () => this.recordTimeline('dc-close', 'DataChannel closed'));
    peer.on('error', (err) => this.recordTimeline('error', `Peer error: ${err.message}`));
    peer.on('iceStateChange', (state: string) => {
      this.recordTimeline('ice-state', `ICE ${state}`);
    });
  }

  start(onUpdate: (snapshot: PCStatsSnapshot) => void): void {
    this.onUpdate = onUpdate;
    this.interval = setInterval(() => this.poll(), PCStatsCollector.POLL_MS);
    this.poll(); // 立即执行一次
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  recordTimeline(type: TimelineEvent['type'], detail: string): void {
    this.timeline.push({ ts: Date.now(), type, detail });
    if (this.timeline.length > PCStatsCollector.MAX_TIMELINE) {
      this.timeline.shift();
    }
  }

  /** 获取底层 RTCPeerConnection（供外部使用） */
  getPeerConnection(): RTCPeerConnection | null {
    return (this.peer as any)._pc as RTCPeerConnection | null;
  }

  // ─── 内部 ────────────────────────────────────────────

  private async poll(): Promise<void> {
    const pc = (this.peer as any)._pc as RTCPeerConnection | undefined;
    if (!pc) {
      this.onUpdate?.(this.emptySnapshot(pc ?? null));
      return;
    }

    try {
      const stats = await pc.getStats();

      const localCandidates: CandidateInfo[] = [];
      const remoteCandidates: CandidateInfo[] = [];
      let selectedPair: SelectedPair | null = null;
      let bytesSent = 0;
      let bytesReceived = 0;
      let packetsSent = 0;
      let packetsReceived = 0;
      let currentRoundTripTime = 0;
      let availableOutgoingBitrate = 0;

      for (const report of stats.values()) {
        switch (report.type) {
          case 'local-candidate': {
            const r = report as Record<string, unknown> & {
              candidateType?: string; protocol?: string; address?: string;
              port?: number; priority?: number;
            };
            localCandidates.push({
              type: (r.candidateType as CandidateInfo['type']) ?? 'host',
              protocol: (r.protocol as CandidateInfo['protocol']) ?? 'udp',
              address: r.address ?? '?',
              port: r.port ?? 0,
              priority: r.priority ?? 0,
            });
            break;
          }
          case 'remote-candidate': {
            const r = report as Record<string, unknown> & {
              candidateType?: string; protocol?: string; address?: string;
              port?: number; priority?: number;
            };
            remoteCandidates.push({
              type: (r.candidateType as CandidateInfo['type']) ?? 'host',
              protocol: (r.protocol as CandidateInfo['protocol']) ?? 'udp',
              address: r.address ?? '?',
              port: r.port ?? 0,
              priority: r.priority ?? 0,
            });
            break;
          }
          case 'candidate-pair': {
            const r = report as unknown as {
              state?: string; localCandidateId?: string; remoteCandidateId?: string;
              nominated?: boolean; currentRoundTripTime?: number; availableOutgoingBitrate?: number;
              bytesSent?: number; bytesReceived?: number; packetsSent?: number; packetsReceived?: number;
            };
            if (r.state === 'succeeded') {
              const local = stats.get(r.localCandidateId ?? '') as Record<string, unknown> | undefined;
              const remote = stats.get(r.remoteCandidateId ?? '') as Record<string, unknown> | undefined;
              selectedPair = {
                local: {
                  type: (local?.candidateType as string) ?? 'unknown',
                  address: (local?.address as string) ?? '?',
                },
                remote: {
                  type: (remote?.candidateType as string) ?? 'unknown',
                  address: (remote?.address as string) ?? '?',
                },
                nominated: r.nominated ?? false,
              };
              currentRoundTripTime = (r.currentRoundTripTime ?? currentRoundTripTime) * 1000;
            }
            bytesSent += r.bytesSent ?? 0;
            bytesReceived += r.bytesReceived ?? 0;
            packetsSent += r.packetsSent ?? 0;
            packetsReceived += r.packetsReceived ?? 0;
            availableOutgoingBitrate = r.availableOutgoingBitrate ?? availableOutgoingBitrate;
            break;
          }
        }
      }

      const dataChannels: DataChannelInfo[] = [];
      // simple-peer 支持 _channel
      const dc = (this.peer as any)._channel as RTCDataChannel | undefined;
      if (dc) {
        dataChannels.push({
          label: dc.label,
          state: dc.readyState,
          bytesSent: 0,
          bytesReceived: 0,
          bufferedAmount: dc.bufferedAmount,
        });
      }

      // 码率差分（Kbps）：真实收发速率，比 availableOutgoingBitrate 更能反映实际体验
      const now = Date.now();
      let sendBitrateKbps = 0;
      let recvBitrateKbps = 0;
      if (this.lastPollTs > 0) {
        const dt = (now - this.lastPollTs) / 1000;
        if (dt > 0.2) {
          sendBitrateKbps = Math.max(0, Math.round(((bytesSent - this.lastBytesSent) * 8) / dt / 1000));
          recvBitrateKbps = Math.max(0, Math.round(((bytesReceived - this.lastBytesReceived) * 8) / dt / 1000));
        }
      }
      this.lastPollTs = now;
      this.lastBytesSent = bytesSent;
      this.lastBytesReceived = bytesReceived;

      this.onUpdate?.({
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        localCandidates: this.dedupCandidates(localCandidates),
        remoteCandidates: this.dedupCandidates(remoteCandidates),
        selectedPair,
        bytesSent,
        bytesReceived,
        packetsSent,
        packetsReceived,
        currentRoundTripTime: Math.round(currentRoundTripTime),
        availableOutgoingBitrate,
        sendBitrateKbps,
        recvBitrateKbps,
        dataChannels,
        timeline: [...this.timeline],
      });
    } catch {
      this.onUpdate?.(this.emptySnapshot(pc));
    }
  }

  private emptySnapshot(pc: RTCPeerConnection | null): PCStatsSnapshot {
    return {
      iceConnectionState: pc?.iceConnectionState ?? 'new',
      iceGatheringState: pc?.iceGatheringState ?? 'new',
      localCandidates: [],
      remoteCandidates: [],
      selectedPair: null,
      bytesSent: 0,
      bytesReceived: 0,
      packetsSent: 0,
      packetsReceived: 0,
      currentRoundTripTime: 0,
      availableOutgoingBitrate: 0,
      sendBitrateKbps: 0,
      recvBitrateKbps: 0,
      dataChannels: [],
      timeline: [...this.timeline],
    };
  }

  private dedupCandidates(cands: CandidateInfo[]): CandidateInfo[] {
    const seen = new Map<string, CandidateInfo>();
    for (const c of cands) {
      const key = `${c.address}:${c.port}`;
      const existing = seen.get(key);
      if (!existing || c.priority > existing.priority) {
        seen.set(key, c);
      }
    }
    return [...seen.values()].sort((a, b) => b.priority - a.priority);
  }
}
