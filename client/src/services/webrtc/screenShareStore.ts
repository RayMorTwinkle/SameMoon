/**
 * 屏幕分享全局状态 — 跨 RoomPage / PlayerPage 共享
 */

import type { PeerConnectionManager } from './PeerConnectionManager';
import type { PCStatsCollector } from './PCStatsCollector';

interface ScreenShareState {
  /** 本地屏幕流（分享方） */
  localStream: MediaStream | null;
  /** 远端屏幕流（观看方） */
  remoteStream: MediaStream | null;
  /** PeerConnectionManager 实例 */
  pcm: PeerConnectionManager | null;
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
  pcm: null,
  collector: null,
  isSharing: false,
  isViewing: false,
};

export const screenShareStore = {
  get state() { return state; },

  setSharing(stream: MediaStream, pcm: PeerConnectionManager, collector: PCStatsCollector) {
    state.localStream = stream;
    state.pcm = pcm;
    state.collector = collector;
    state.isSharing = true;
    state.isViewing = false;
  },

  setViewing(stream: MediaStream, pcm: PeerConnectionManager, collector: PCStatsCollector) {
    state.remoteStream = stream;
    state.pcm = pcm;
    state.collector = collector;
    state.isViewing = true;
    state.isSharing = false;
  },

  /** PCM 创建后立即注册（不等 track），让 RoomPage 能转发 ICE 候选 */
  setPendingPCM(pcm: PeerConnectionManager) {
    state.pcm = pcm;
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
    state.pcm?.close();
    state.pcm = null;
    state.collector = null;
    state.isSharing = false;
    state.isViewing = false;
  },
};
