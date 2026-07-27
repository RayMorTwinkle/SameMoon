/**
 * PCStatsCollector — WebRTC 统计信息采集器
 * 每 2s 从 RTCPeerConnection.getStats() 拉取数据
 * 供 DebugPanel 实时展示
 */

import type { PeerConnectionManager } from './PeerConnectionManager';
import type {
  PCStatsSnapshot, CandidateInfo, SelectedPair, DataChannelInfo, TimelineEvent,
} from './types';

export class PCStatsCollector {
  private pcm: PeerConnectionManager;
  private interval: ReturnType<typeof setInterval> | null = null;
  private timeline: TimelineEvent[] = [];
  private onUpdate?: (snapshot: PCStatsSnapshot) => void;
  private onTimelineUpdate?: (entry: TimelineEvent) => void;

  private static readonly POLL_MS = 2000;
  private static readonly MAX_TIMELINE = 50;

  constructor(pcm: PeerConnectionManager) {
    this.pcm = pcm;

    // 监听 PeerConnectionManager 的时间线事件
    pcm.setTimelineHandler((entry) => {
      this.timeline.push(entry);
      if (this.timeline.length > PCStatsCollector.MAX_TIMELINE) {
        this.timeline.shift();
      }
      this.onTimelineUpdate?.(entry);
    });
  }

  start(onUpdate: (snapshot: PCStatsSnapshot) => void): void {
    this.onUpdate = onUpdate;
    this.interval = setInterval(() => this.poll(), PCStatsCollector.POLL_MS);
    // 立即执行一次
    this.poll();
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

  // ─── 内部 ────────────────────────────────────────────

  private async poll(): Promise<void> {
    const pc = this.pcm.getPeerConnection();
    if (!pc) {
      this.onUpdate?.(this.emptySnapshot(pc));
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
              currentRoundTripTime = (r.currentRoundTripTime ?? currentRoundTripTime) * 1000; // s→ms
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

      // DataChannel 统计
      const dataChannels: DataChannelInfo[] = [];
      for (const dc of this.pcm.getDataChannels()) {
        dataChannels.push({
          label: dc.label,
          state: dc.readyState,
          bytesSent: 0,   // DataChannel 字节在 candidate-pair 级别统计
          bytesReceived: 0,
          bufferedAmount: dc.bufferedAmount,
        });
      }

      this.onUpdate?.({
        iceConnectionState: this.pcm.iceConnectionState,
        iceGatheringState: this.pcm.iceGatheringState,
        localCandidates: this.dedupCandidates(localCandidates),
        remoteCandidates: this.dedupCandidates(remoteCandidates),
        selectedPair,
        bytesSent,
        bytesReceived,
        packetsSent,
        packetsReceived,
        currentRoundTripTime: Math.round(currentRoundTripTime),
        availableOutgoingBitrate,
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
      dataChannels: [],
      timeline: [...this.timeline],
    };
  }

  /** 去重候选（同一地址+端口只保留优先级最高者） */
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
