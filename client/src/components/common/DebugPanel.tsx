import { useState, useRef, useEffect } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { Bug, X } from 'lucide-react';

interface LogEntry {
  ts: number;
  text: string;
}

/** 简易全局日志收集（最多 20 条） */
const logStore: LogEntry[] = [];
export function debugLog(text: string) {
  logStore.push({ ts: Date.now(), text });
  if (logStore.length > 20) logStore.shift();
  console.debug('[SameMoon]', text);
}

export function DebugPanel() {
  const { status, userId, reconnectCount } = useWebSocket();
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([...logStore]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 定时刷新日志和时钟偏移
  useEffect(() => {
    if (!open) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      setLogs([...logStore]);
      // 从 ClockSync 实例获取偏移（如果可用）
      // 简单实现：无直接访问，只展示日志
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [open]);

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

  return (
    <div className="fixed bottom-4 right-4 w-80 max-h-96 bg-white/95 border border-[#c4b89e] rounded-xl shadow-lg p-4 z-50 overflow-y-auto">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold text-[#794f27]">调试面板</span>
        <button onClick={() => setOpen(false)} className="text-[#794f27] hover:opacity-60">
          <X size={16} />
        </button>
      </div>

      {/* 状态信息 */}
      <div className="space-y-1.5 mb-3 text-xs">
        <div className="flex justify-between">
          <span className="opacity-50">WS 状态</span>
          <span className={
            status === 'connected' ? 'text-green-600' :
            status === 'reconnecting' ? 'text-yellow-600' : 'text-red-500'
          }>
            {status}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="opacity-50">User ID</span>
          <span className="truncate max-w-[160px]">{userId?.slice(0, 12) ?? '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="opacity-50">重连次数</span>
          <span>{reconnectCount}</span>
        </div>
      </div>

      {/* 最近日志 */}
      <div className="border-t border-[#c4b89e] pt-2">
        <p className="text-xs font-medium text-[#794f27] mb-1">最近日志</p>
        <div className="space-y-0.5 max-h-48 overflow-y-auto">
          {logs.length === 0 ? (
            <p className="text-xs opacity-30">暂无日志</p>
          ) : logs.map((l, i) => (
            <p key={i} className="text-[10px] font-mono opacity-60 leading-tight">
              <span className="opacity-40">{new Date(l.ts).toLocaleTimeString()}</span>{' '}
              {l.text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
