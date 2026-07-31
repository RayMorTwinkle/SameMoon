import { useState } from 'react';
import { ClipboardCopy, Check } from 'lucide-react';
import { debugStore } from '../../services/debugStore';

/**
 * 悬浮"复制诊断日志"按钮
 * 一键复制完整诊断快照（WS 消息时间线 + 结构化事件 + 全局错误 + 环境信息），
 * 出问题时直接贴给 AI 排错，无需手动描述现象。
 */
export function DebugExport() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = debugStore.exportDiagnostics();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // HTTP 环境降级
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      title="复制诊断日志（贴给 AI 排错）"
      className="fixed bottom-3 left-3 z-50 flex items-center gap-1 px-2 py-1 text-[10px] rounded-full border border-gray-300 bg-white/80 text-gray-500 opacity-40 hover:opacity-90 transition-opacity"
    >
      {copied ? <Check size={11} className="text-green-600" /> : <ClipboardCopy size={11} />}
      {copied ? '已复制' : '诊断日志'}
    </button>
  );
}
