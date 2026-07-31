/** WebRTC 相关类型定义 */

export interface CandidateInfo {
  type: 'host' | 'srflx' | 'relay';
  protocol: 'udp' | 'tcp';
  address: string;
  port: number;
  priority: number;
}

export interface SelectedPair {
  local: { type: string; address: string };
  remote: { type: string; address: string };
  nominated: boolean;
}

export interface DataChannelInfo {
  label: string;
  state: RTCDataChannelState;
  bytesSent: number;
  bytesReceived: number;
  bufferedAmount: number;
}

export interface PCStatsSnapshot {
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  localCandidates: CandidateInfo[];
  remoteCandidates: CandidateInfo[];
  selectedPair: SelectedPair | null;
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
  currentRoundTripTime: number;
  availableOutgoingBitrate: number;
  /** 实际发送码率（Kbps，poll 差分） */
  sendBitrateKbps: number;
  /** 实际接收码率（Kbps，poll 差分） */
  recvBitrateKbps: number;
  dataChannels: DataChannelInfo[];
  timeline: TimelineEvent[];
}

export interface TimelineEvent {
  ts: number;
  type: 'ice-state' | 'gathering' | 'pair-selected' | 'dc-open' | 'dc-close'
      | 'track-added' | 'track-removed' | 'signal' | 'error';
  detail: string;
}

export type ConnectionRoute = 'direct' | 'stun' | 'turn' | 'unknown';
