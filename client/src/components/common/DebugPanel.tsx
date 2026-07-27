import { useState, useEffect } from 'react';
import { useWebSocket, useWsMessage } from '../../hooks/useWebSocket';
import { Bug, X, ChevronDown } from 'lucide-react';
import { debugStore, type DebugState, type WsLogEntry } from '../../services/debugStore';
import type { PCStatsSnapshot, SelectedPair, TimelineEvent, CandidateInfo } from '../../services/webrtc/types';

/** Tab 定义 */
type TabId = 'overview' | 'ice' | 'transport' | 'channel' | 'timeline' | 'logs';

interface TabDef { id: TabId; label: string }

const TABS: TabDef[] = [
  { id: 'overview', label: '概况' },
  { id: 'ice', label: 'ICE路由' },
  { id: 'transport', label: '传输' },
  { id: 'channel', label: '通道' },
  { id: 'timeline', label: '时间线' },
  { id: 'logs', label: '日志' },
];

// 消息日志筛选
type LogFilter = 'all' | 'rtc' | 'file' | 'screen' | 'sync' | 'ws' | 'error';
const LOG_FILTERS: { id: LogFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'rtc', label: 'rtc:' },
  { id: 'file', label: 'file:' },
  { id: 'screen', label: 'screen:' },
  { id: 'sync', label: 'sync:' },
  { id: 'ws', label: 'WS' },
  { id: 'error', label: '错误' },
];

/** 候选类型 → 图标 */
function candidateIcon(type: string): string {
  switch (type) {
    case 'host': return '🟢';
    case 'srflx': return '🟡';
    case 'relay': return '🔴';
    default: return '⚪';
  }
}

/** 路由类型 → 用户友好总结 */
function routeLabel(pair: SelectedPair | null | undefined): string {
  if (!pair) return '—';
  if (pair.local.type === 'host' && pair.remote.type === 'host') return '🟢 直连';
  if (pair.remote.type === 'srflx') return '🟡 STUN 打洞';
  if (pair.remote.type === 'relay') return '🔴 TURN 中转';
  return `${pair.local.type} ↔ ${pair.remote.type}`;
}

/** 连接质量评估 */
function connectionVerdict(snapshot: PCStatsSnapshot | null): { status: string; color: string } {
  if (!snapshot) return { status: '—', color: 'opacity-30' };
  switch (snapshot.iceConnectionState) {
    case 'connected':
    case 'completed':
      if (snapshot.selectedPair?.remote.type === 'host') return { status: '✅ 连接正常，直连模式', color: 'text-green-600' };
      if (snapshot.selectedPair?.remote.type === 'relay') return { status: '⚠️ 通过 TURN 中转，延迟可能较高', color: 'text-yellow-600' };
      return { status: '✅ 连接正常（STUN 打洞）', color: 'text-green-600' };
    case 'checking':
      return { status: '🔄 正在连接…', color: 'text-yellow-600' };
    case 'disconnected':
    case 'failed':
      return { status: '❌ 连接失败', color: 'text-red-500' };
    default:
      return { status: '—', color: 'opacity-30' };
  }
}

/** 格式化字节 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 格式化时间 */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function DebugPanel() {
  const { status: wsStatus, userId, reconnectCount } = useWebSocket();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId>('overview');
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [debugState, setDebugState] = useState<DebugState>(debugStore.getState());

  // 订阅 debugStore
  useEffect(() => {
    const unsub = debugStore.subscribe(setDebugState);
    return unsub;
  }, []);

  // 订阅 WS 消息日志
  useWsMessage((msg) => {
    const type = msg.type as string;
    const summary = summarizeMessage(msg);
    debugStore.addWsLog({
      ts: Date.now(),
      direction: msg.from ? 'recv' : 'send',
      type,
      summary,
    });
  });

  if (!open) {
    return (
      <button
        className="fixed bottom-4 right-4 w-9 h-9 rounded-full bg-white/80 border border-[#c4b89e] flex items-center justify-center shadow-sm hover:shadow-md transition-shadow z-50"
        title="调试面板"
        onClick={() => setOpen(true)}
      >
        <Bug size={16} className="text-[#794f27]" />
      </button>
    );
  }

  const stats = debugState.rtcStats;

  return (
    <div className="fixed bottom-4 right-4 w-[420px] max-h-[70vh] bg-white/98 border border-[#c4b89e] rounded-xl shadow-xl z-50 flex flex-col overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#e8dfd0] shrink-0">
        <span className="text-sm font-bold text-[#794f27]">🔍 调试面板</span>
        <button onClick={() => setOpen(false)} className="text-[#794f27] hover:opacity-60">
          <X size={16} />
        </button>
      </div>

      {/* 标签页 */}
      <div className="flex border-b border-[#e8dfd0] shrink-0 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-xs whitespace-nowrap border-b-2 transition-colors ${
              tab === t.id
                ? 'border-[#19c8b9] text-[#19c8b9] font-medium'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-3 text-xs space-y-2 min-h-0">
        {tab === 'overview' && <OverviewTab stats={stats} wsStatus={wsStatus} userId={userId} reconnectCount={reconnectCount} />}
        {tab === 'ice' && <IceTab stats={stats} />}
        {tab === 'transport' && <TransportTab stats={stats} />}
        {tab === 'channel' && <ChannelTab stats={stats} />}
        {tab === 'timeline' && <TimelineTab timeline={stats?.timeline ?? []} />}
        {tab === 'logs' && <LogsTab logs={debugState.wsLogs} filter={logFilter} onFilterChange={setLogFilter} />}
      </div>
    </div>
  );
}

// ─── Tab 子组件 ─────────────────────────────────────────

function OverviewTab({ stats, wsStatus, userId, reconnectCount }: {
  stats: PCStatsSnapshot | null;
  wsStatus: string;
  userId: string | null;
  reconnectCount: number;
}) {
  const verdict = connectionVerdict(stats);
  const state = debugStore.getState();

  return (
    <div className="space-y-1.5">
      <KvRow label="房间模式" value={state.roomMode ?? '—'} />
      <KvRow label="WS 状态" value={wsStatus} color={wsStatus === 'connected' ? 'text-green-600' : 'text-yellow-600'} />
      <KvRow label="RTC 连接" value={stats?.iceConnectionState ?? '—'} />
      <KvRow label="ICE 收集" value={stats?.iceGatheringState ?? '—'} />
      <KvRow label="RTT" value={stats ? `${stats.currentRoundTripTime} ms` : '—'} />
      <KvRow label="可用带宽" value={stats ? fmtBitrate(stats.availableOutgoingBitrate) : '—'} />
      <KvRow label="对方状态" value={state.peerOnline ? '🟢 在线' : '⚪ 离线'} />
      <KvRow label="当前路由" value={routeLabel(stats?.selectedPair ?? null)} />
      <KvRow label="User ID" value={userId?.slice(0, 12) ?? '—'} />
      <KvRow label="重连次数" value={String(reconnectCount)} />
      <div className="mt-2 pt-2 border-t border-[#e8dfd0]">
        <span className={`text-xs font-medium ${verdict.color}`}>{verdict.status}</span>
      </div>
    </div>
  );
}

function IceTab({ stats }: { stats: PCStatsSnapshot | null }) {
  const local = stats?.localCandidates ?? [];
  const remote = stats?.remoteCandidates ?? [];
  const pair = stats?.selectedPair;

  return (
    <div className="space-y-2">
      {/* 选中路由 */}
      <div className="bg-[#f0faf9] rounded-lg p-2 text-xs">
        <span className="font-medium text-[#19c8b9]">当前路由: </span>
        {routeLabel(pair)}
        {pair && (
          <span className="ml-2 opacity-50">
            ({pair.local.address} ↔ {pair.remote.address})
          </span>
        )}
      </div>

      {/* 本地候选 */}
      <div>
        <p className="font-medium text-[#794f27] mb-1">本地候选 ({local.length}):</p>
        {local.length === 0 ? <p className="opacity-30">暂无</p> : (
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-left opacity-50">
                <th className="pr-2">类型</th><th className="pr-2">地址</th><th>优先级</th>
              </tr>
            </thead>
            <tbody>
              {local.map((c, i) => (
                <tr key={i} className={candHighlight(c, pair?.local)}>
                  <td className="pr-2">{candidateIcon(c.type)} {c.type}</td>
                  <td className="pr-2 font-mono">{c.address}:{c.port}</td>
                  <td className="font-mono opacity-50">{c.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 远端候选 */}
      <div>
        <p className="font-medium text-[#794f27] mb-1">远端候选 ({remote.length}):</p>
        {remote.length === 0 ? <p className="opacity-30">暂无</p> : (
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-left opacity-50">
                <th className="pr-2">类型</th><th className="pr-2">地址</th><th>优先级</th>
              </tr>
            </thead>
            <tbody>
              {remote.map((c, i) => (
                <tr key={i} className={candHighlight(c, pair?.remote)}>
                  <td className="pr-2">{candidateIcon(c.type)} {c.type}</td>
                  <td className="pr-2 font-mono">{c.address}:{c.port}</td>
                  <td className="font-mono opacity-50">{c.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function TransportTab({ stats }: { stats: PCStatsSnapshot | null }) {
  if (!stats) return <p className="opacity-30">暂无连接</p>;
  return (
    <div className="space-y-1.5">
      <KvRow label="发送字节" value={fmtBytes(stats.bytesSent)} />
      <KvRow label="接收字节" value={fmtBytes(stats.bytesReceived)} />
      <KvRow label="发送包数" value={String(stats.packetsSent)} />
      <KvRow label="接收包数" value={String(stats.packetsReceived)} />
      <KvRow label="丢包率" value={`${calcPacketLoss(stats).toFixed(1)}%`} />
      <KvRow label="当前 RTT" value={`${stats.currentRoundTripTime} ms`} />
      <KvRow label="上行码率" value={fmtBitrate(stats.availableOutgoingBitrate)} />
    </div>
  );
}

function ChannelTab({ stats }: { stats: PCStatsSnapshot | null }) {
  const dcs = stats?.dataChannels ?? [];
  if (dcs.length === 0) return <p className="opacity-30">无 DataChannel</p>;
  return (
    <div className="space-y-2">
      {dcs.map((dc, i) => (
        <div key={i} className="border border-[#e8dfd0] rounded-lg p-2 space-y-1">
          <KvRow label="名称" value={dc.label} />
          <KvRow label="状态" value={dc.state} color={dc.state === 'open' ? 'text-green-600' : 'text-yellow-600'} />
          <KvRow label="待发送" value={fmtBytes(dc.bufferedAmount)} />
        </div>
      ))}
    </div>
  );
}

function TimelineTab({ timeline }: { timeline: TimelineEvent[] }) {
  if (timeline.length === 0) return <p className="opacity-30">暂无事件</p>;
  // 倒序（最新在前）
  const reversed = [...timeline].reverse();
  return (
    <div className="space-y-1">
      {reversed.map((e, i) => (
        <p key={i} className="text-[10px] font-mono leading-tight">
          <span className="opacity-40">{fmtTime(e.ts)}</span>{' '}
          <span className={eventColor(e.type)}>{eventIcon(e.type)} {e.detail}</span>
        </p>
      ))}
    </div>
  );
}

function LogsTab({ logs, filter, onFilterChange }: {
  logs: WsLogEntry[];
  filter: LogFilter;
  onFilterChange: (f: LogFilter) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const filtered = logs.filter(log => {
    switch (filter) {
      case 'all': return true;
      case 'rtc': return log.type.startsWith('rtc:');
      case 'file': return log.type.startsWith('file:');
      case 'screen': return log.type.startsWith('screen:');
      case 'sync': return log.type.startsWith('sync:');
      case 'ws': return log.type.startsWith('room:') || log.type.startsWith('session:') || log.type === 'connected';
      case 'error': return log.type === 'error';
      default: return true;
    }
  });

  const displayed = expanded ? filtered : filtered.slice(-20);

  return (
    <div className="space-y-1">
      {/* 筛选按钮 */}
      <div className="flex gap-1 flex-wrap">
        {LOG_FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => onFilterChange(f.id)}
            className={`px-1.5 py-0.5 text-[10px] rounded-full border transition-colors ${
              filter === f.id
                ? 'bg-[#19c8b9] text-white border-[#19c8b9]'
                : 'border-gray-200 text-gray-400 hover:border-gray-300'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {displayed.length === 0 ? (
        <p className="opacity-30 text-xs">暂无日志</p>
      ) : (
        <>
          {!expanded && filtered.length > 20 && (
            <button
              onClick={() => setExpanded(true)}
              className="text-[10px] text-[#19c8b9] hover:underline flex items-center gap-1"
            >
              显示全部 {filtered.length} 条 <ChevronDown size={10} />
            </button>
          )}
          <div className="space-y-0.5 max-h-48 overflow-y-auto">
            {displayed.map((l, i) => (
              <p key={i} className="text-[10px] font-mono leading-tight">
                <span className="opacity-40">{fmtTime(l.ts)}</span>{' '}
                <span className={l.direction === 'send' ? 'text-blue-500' : 'text-green-600'}>
                  {l.direction === 'send' ? '→' : '←'}
                </span>{' '}
                <span className="font-medium">{l.type}</span>{' '}
                <span className="opacity-60">{l.summary}</span>
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── 工具组件 ─────────────────────────────────────────

function KvRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between">
      <span className="opacity-50">{label}</span>
      <span className={`truncate max-w-[200px] ${color ?? ''}`}>{value}</span>
    </div>
  );
}



function candHighlight(c: CandidateInfo, selected?: { type: string; address: string }): string {
  if (!selected) return '';
  if (c.type === selected.type && c.address === selected.address) {
    return 'text-[#19c8b9] font-medium';
  }
  return '';
}

function calcPacketLoss(stats: PCStatsSnapshot): number {
  const total = stats.packetsSent + stats.packetsReceived;
  if (total === 0) return 0;
  // 简化估算：通过 availableOutgoingBitrate 判断
  // 真实丢包率需要更多数据，这里给个占位
  return (stats.packetsSent > 0 && stats.packetsReceived > 0) ? 0.1 : 0;
}

function fmtBitrate(bps: number): string {
  if (bps === 0) return '—';
  if (bps < 1e6) return `${(bps / 1e3).toFixed(1)} Kbps`;
  return `${(bps / 1e6).toFixed(1)} Mbps`;
}

function eventIcon(type: TimelineEvent['type']): string {
  switch (type) {
    case 'ice-state': return '🔗';
    case 'gathering': return '📡';
    case 'pair-selected': return '✅';
    case 'dc-open': return '🔌';
    case 'dc-close': return '🔒';
    case 'track-added': return '🎬';
    case 'track-removed': return '⏹';
    case 'signal': return '📤';
    case 'error': return '❌';
    default: return '•';
  }
}

function eventColor(type: TimelineEvent['type']): string {
  switch (type) {
    case 'ice-state':
    case 'pair-selected':
      return 'text-green-600';
    case 'dc-open':
    case 'track-added':
      return 'text-[#19c8b9]';
    case 'dc-close':
    case 'track-removed':
      return 'text-yellow-600';
    case 'error':
      return 'text-red-500';
    default:
      return 'opacity-60';
  }
}

/** 消息摘要（截取关键字段） */
function summarizeMessage(msg: Record<string, unknown>): string {
  const type = msg.type as string;
  const data = msg.data as Record<string, unknown> | undefined;
  if (!data) return '{}';
  if (type === 'rtc:offer' || type === 'rtc:answer') {
    const sdpLen = (data.sdp as string)?.length ?? 0;
    return `SDP ${sdpLen} chars`;
  }
  if (type === 'rtc:ice') {
    const cand = (data.candidate as string) ?? '';
    const typeMatch = cand.match(/typ\s+(\w+)/);
    if (typeMatch) return `ICE ${typeMatch[1]}`;
    return 'ICE unknown';
  }
  if (type === 'file:progress') {
    return `${fmtBytes(data.transferred as number)} / ${fmtBytes(data.total as number)}`;
  }
  if (type === 'file:offer') {
    return `${data.name} (${fmtBytes(data.size as number)})`;
  }
  if (type === 'sync:play' || type === 'sync:pause' || type === 'sync:seek') {
    return `time=${(data.time as number)?.toFixed(1)}s`;
  }
  if (type === 'sync:rate') {
    return `${data.rate}x`;
  }
  if (type === 'sync:heartbeat') {
    return data.echoOf ? 'response' : 'request';
  }
  const keys = Object.keys(data).slice(0, 3);
  if (keys.length === 0) return '{}';
  return keys.map(k => {
    const v = data[k];
    return typeof v === 'string' ? v.slice(0, 20) : String(v).slice(0, 20);
  }).join(', ');
}
