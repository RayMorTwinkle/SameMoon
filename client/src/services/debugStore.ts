/**
 * 全局调试状态 Store
 * ScreenShareService / PCStatsCollector 写入，DebugPanel 读取
 */

import type { PCStatsSnapshot } from './webrtc/types';

export interface WsLogEntry {
  ts: number;
  direction: 'send' | 'recv';
  type: string;
  summary: string;
}

/** 结构化事件日志条目（用于诊断导出） */
export interface DebugEvent {
  ts: number;
  level: 'info' | 'error';
  module: string;
  action: string;
  detail: string;
}

/** 截断序列化，防止大对象撑爆日志 */
function truncate(data: unknown, max = 300): string {
  if (data === undefined || data === null) return '';
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch {
    return String(data);
  }
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
  const MAX_LOGS = 300;

  // 事件日志（独立于响应式 state，避免高频 notify 引起重渲染）
  const events: DebugEvent[] = [];
  const MAX_EVENTS = 200;
  function pushEvent(level: 'info' | 'error', module: string, action: string, detail?: unknown) {
    events.push({ ts: Date.now(), level, module, action, detail: truncate(detail) });
    if (events.length > MAX_EVENTS) events.shift();
  }

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

    /** 记录 WS 收发消息（保活消息不入日志） */
    logWs(direction: 'send' | 'recv', type: string, data?: unknown) {
      if (type === 'ping' || type === 'pong') return;
      state.wsLogs.push({ ts: Date.now(), direction, type, summary: truncate(data) });
      if (state.wsLogs.length > MAX_LOGS) state.wsLogs.shift();
      notify();
    },

    /** 记录结构化事件（module/action/detail，用于诊断导出） */
    log(module: string, action: string, detail?: unknown) {
      pushEvent('info', module, action, detail);
    },

    /** 记录错误事件（同时输出 console.error 便于开发时观察） */
    logError(module: string, action: string, detail?: unknown) {
      pushEvent('error', module, action, detail);
      console.error(`[${module}] ${action}:`, detail);
    },

    /** 导出完整诊断快照（复制给 AI 排错用） */
    exportDiagnostics(): string {
      return JSON.stringify({
        meta: {
          exportedAt: new Date().toISOString(),
          url: window.location.href,
          userAgent: navigator.userAgent,
          sessionId: sessionStorage.getItem('sm-session'),
        },
        room: {
          mode: state.roomMode,
          code: state.roomCode,
          peerOnline: state.peerOnline,
        },
        events: [...events],
        wsLogs: [...state.wsLogs],
      }, null, 1);
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

// 全局错误捕获：未处理异常 / Promise rejection 自动进入诊断日志
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    debugStore.logError('global', 'window-error', `${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    debugStore.logError('global', 'unhandled-rejection', String(e.reason));
  });
}

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
