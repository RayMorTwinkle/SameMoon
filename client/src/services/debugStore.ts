/**
 * 全局调试状态 Store
 * PeerConnectionManager / PCStatsCollector 写入，DebugPanel 读取
 */

import type { PCStatsSnapshot } from './webrtc/types';

export interface WsLogEntry {
  ts: number;
  direction: 'send' | 'recv';
  type: string;
  summary: string;
}

export interface DebugState {
  // WS 消息日志（最近 100 条）
  wsLogs: WsLogEntry[];
  // WebRTC 统计快照
  rtcStats: PCStatsSnapshot | null;
  // 房间信息
  roomMode: string | null;
  roomCode: string | null;
  // 对方在线状态
  peerOnline: boolean;
}

type Listener = (state: DebugState) => void;

function createDebugStore() {
  const state: DebugState = {
    wsLogs: [],
    rtcStats: null,
    roomMode: null,
    roomCode: null,
    peerOnline: false,
  };

  const listeners = new Set<Listener>();
  const MAX_LOGS = 100;

  function notify() {
    for (const fn of listeners) {
      fn({ ...state, wsLogs: [...state.wsLogs] });
    }
  }

  return {
    getState(): DebugState {
      return { ...state, wsLogs: [...state.wsLogs] };
    },

    subscribe(fn: Listener): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    addWsLog(entry: WsLogEntry) {
      state.wsLogs.push(entry);
      if (state.wsLogs.length > MAX_LOGS) state.wsLogs.shift();
      notify();
    },

    setRtcStats(stats: PCStatsSnapshot | null) {
      state.rtcStats = stats;
      notify();
    },

    setRoomInfo(mode: string | null, code: string | null) {
      state.roomMode = mode;
      state.roomCode = code;
      notify();
    },

    setPeerOnline(online: boolean) {
      state.peerOnline = online;
      notify();
    },
  };
}

export const debugStore = createDebugStore();

/** 从 RTCIceServer[] 提取 STUN/TURN 服务器简表 */
export function summarizeIceServers(servers: RTCIceServer[]): string[] {
  const out: string[] = [];
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls ?? ''];
    for (const u of urls) {
      const isTurn = u.startsWith('turn:') || u.startsWith('turns:');
      out.push(isTurn ? `🔄 TURN: ${u}` : `🔍 STUN: ${u}`);
    }
  }
  return out;
}
