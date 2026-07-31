/**
 * 屏幕分享全局状态 — 跨 RoomPage / PlayerPage 共享
 * 基于 simple-peer：Peer.Instance 替代手动 RTCPeerConnection
 */

import type Peer from 'simple-peer';
import type { PCStatsCollector } from './PCStatsCollector';

interface ScreenShareState {
  /** 本地屏幕流（分享方） */
  localStream: MediaStream | null;
  /** 远端屏幕流（观看方） */
  remoteStream: MediaStream | null;
  /** simple-peer Peer 实例 */
  peer: Peer.Instance | null;
  /** 统计采集器 */
  collector: PCStatsCollector | null;
  /** 是否正在分享 */
  isSharing: boolean;
  /** 是否正在观看 */
  isViewing: boolean;
}

const state: ScreenShareState = {
  localStream: null,
  remoteStream: null,
  peer: null,
  collector: null,
  isSharing: false,
  isViewing: false,
};

export const screenShareStore = {
  get state() { return state; },

  setSharing(stream: MediaStream, peer: Peer.Instance, collector: PCStatsCollector) {
    state.localStream = stream;
    state.peer = peer;
    state.collector = collector;
    state.isSharing = true;
    state.isViewing = false;
  },

  setViewing(stream: MediaStream, peer: Peer.Instance, collector: PCStatsCollector) {
    state.remoteStream = stream;
    state.peer = peer;
    state.collector = collector;
    state.isViewing = true;
    state.isSharing = false;
  },

  /** Peer 创建后立即注册，让 RoomPage 能转发后续 signal */
  setPendingPeer(peer: Peer.Instance) {
    state.peer = peer;
  },

  /** 获取当前活跃的流（分享端拿 localStream，观看端拿 remoteStream） */
  getActiveStream(): MediaStream | null {
    return state.localStream || state.remoteStream;
  },

  /** 获取当前角色 */
  isSharer(): boolean { return state.isSharing; },
  isViewer(): boolean { return state.isViewing; },

  reset() {
    state.localStream?.getTracks().forEach(t => t.stop());
    state.localStream = null;
    state.remoteStream = null;
    state.collector?.stop();
    (state.peer as any)?.destroy?.();
    state.peer = null;
    state.collector = null;
    state.isSharing = false;
    state.isViewing = false;
  },
};
