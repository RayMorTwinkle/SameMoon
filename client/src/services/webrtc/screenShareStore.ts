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

  /** 观看端设置抖动缓冲目标（ms）：越大越丝滑、延迟越高。设在所有 receiver 上保持 A/V 同步 */
  setJitterBufferTarget(ms: number) {
    const pc = (state.peer as any)?._pc as RTCPeerConnection | undefined;
    if (!pc) return;
    for (const r of pc.getReceivers()) {
      const rr = r as unknown as { jitterBufferTarget?: number; playoutDelayHint?: number };
      try {
        if ('jitterBufferTarget' in rr) rr.jitterBufferTarget = ms;          // Chrome/Edge 114+（毫秒）
        else if ('playoutDelayHint' in rr) rr.playoutDelayHint = ms / 1000;  // 旧版回退（秒）
      } catch { /* ignore */ }
    }
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
