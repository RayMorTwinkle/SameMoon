/**
 * FileTransferPanel — 文件传输模式 UI + 逻辑（房间页内）
 *
 * 自订阅 WS（useWsMessage），完全自管 file:offer/accept/cancelled 与 rtc:signal，
 * 与 RoomPage 解耦。两种子模式：
 *   - complete 完整传输：收齐 → File → 直接可播（并可另存）
 *   - stream 流式播放：边收边喂 MSE，缓存一点即可播；对方网速跟不上时视频 stall，
 *     经 SyncEngine 的 sync:buffering 让房主自动暂停（复用现有缓冲协商）
 */

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Notification } from 'animal-island-ui';
import { useWebSocket, useWsMessage } from '../../hooks/useWebSocket';
import { isValidVideoFile, FORMAT_HINT } from '../../utils/fileValidator';
import { formatFileSize } from '../../utils/formatFileSize';
import { setSharedFile } from '../../services/room/fileStore';
import { FileTransferService, type FileMeta } from '../../services/webrtc/FileTransferService';
import { fileTransferStore, type TransferMode } from '../../services/webrtc/fileTransferStore';
import { MseStreamController } from '../../services/playback/MseStreamController';
import { debugStore } from '../../services/debugStore';
import { Upload, Download, FileVideo, Play, Zap } from 'lucide-react';

type Phase = 'idle' | 'offering' | 'incoming' | 'transferring' | 'error';

interface Props {
  role: 'host' | 'guest' | null;
  peerJoined: boolean;
  code: string;
}

export function FileTransferPanel({ role, peerJoined, code }: Props) {
  const navigate = useNavigate();
  const { send } = useWebSocket();

  const [phase, setPhase] = useState<Phase>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [transferMode, setTransferMode] = useState<TransferMode>('stream');
  const [incoming, setIncoming] = useState<FileMeta & { transferMode: TransferMode } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const serviceRef = useRef<FileTransferService | null>(null);
  const navigatedRef = useRef(false);

  const goPlay = (mode: TransferMode) => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    navigate(`/room/${code}/play`, {
      state: { mode: mode === 'stream' ? 'file-stream' : 'file-complete' },
    });
  };

  // ─── 房主：选文件 + 发送 ──────────────────────────────
  const handlePickFile = (file: File) => {
    if (!isValidVideoFile(file)) {
      Notification.error({ message: '格式不支持', description: FORMAT_HINT });
      return;
    }
    setSelectedFile(file);
    // 默认流式；不可流式的格式（如 MKV）自动退回完整传输
    setTransferMode(MseStreamController.canStream(file.name, file.type) ? 'stream' : 'complete');
  };

  const handleSendOffer = () => {
    if (!selectedFile) return;
    send({
      type: 'file:offer',
      data: { name: selectedFile.name, size: selectedFile.size, type: selectedFile.type, transferMode },
    });
    setPhase('offering');
  };

  const startHostSend = async (file: File, mode: TransferMode) => {
    const svc = new FileTransferService();
    serviceRef.current = svc;
    fileTransferStore.setService(svc, mode, { name: file.name, size: file.size, type: file.type });
    setPhase('transferring');
    setProgress({ done: 0, total: file.size });
    if (mode === 'stream') setSharedFile(file); // 房主播放自己的本地文件

    await svc.startSending(file, d => send({ type: 'rtc:signal', data: d }), {
      onProgress: (s, t) => setProgress({ done: s, total: t }),
      onState: st => {
        if (st === 'error') { setPhase('error'); }
        // 流式：连接建立即进入播放页（后台继续发送）
        if (st === 'transferring' && mode === 'stream') goPlay('stream');
      },
      onDone: () => {
        // 完整：全部发完后房主自己也进入播放
        if (mode === 'complete') { setSharedFile(file); goPlay('complete'); }
      },
    });
  };

  // ─── 对方：接收 ──────────────────────────────────────
  const startGuestReceive = async (meta: FileMeta & { transferMode: TransferMode }) => {
    const mode = meta.transferMode;
    const svc = new FileTransferService();
    serviceRef.current = svc;
    fileTransferStore.setService(svc, mode, meta);
    setPhase('transferring');
    setProgress({ done: 0, total: meta.size });

    const canStream = mode === 'stream' && MseStreamController.canStream(meta.name, meta.type);
    let controller: MseStreamController | null = null;
    if (canStream) {
      controller = new MseStreamController(meta.name, meta.type);
      fileTransferStore.setController(controller);
    }

    await svc.startReceiving(meta, d => send({ type: 'rtc:signal', data: d }), {
      onProgress: (r, t) => setProgress({ done: r, total: t }),
      onState: st => {
        if (st === 'error') setPhase('error');
        if (st === 'transferring' && canStream) goPlay('stream');
      },
      onChunk: canStream ? (chunk => controller!.append(chunk)) : undefined,
      onComplete: file => {
        if (canStream) { controller!.complete(); return; }
        // 完整（或流式不支持时降级）：拿到 File → 直接可播
        if (file) { setSharedFile(file); goPlay('complete'); }
      },
    });

    // peer 已就绪，通知房主开始发送
    send({ type: 'file:accept', data: {} });
  };

  // ─── WS 消息 ─────────────────────────────────────────
  const handleWs = (msg: Record<string, unknown>) => {
    const data = msg.data as Record<string, unknown>;
    switch (msg.type) {
      case 'file:offer':
        if (role !== 'host') {
          setIncoming(data as unknown as FileMeta & { transferMode: TransferMode });
          setPhase('incoming');
        }
        break;
      case 'file:accept':
        if (role === 'host' && selectedFile) void startHostSend(selectedFile, transferMode);
        break;
      case 'rtc:signal':
        serviceRef.current?.signal(data);
        break;
      case 'file:cancelled':
        debugStore.log('ft', 'cancelled', (data?.reason as string) ?? '');
        Notification.warning({ message: '传输已取消', description: (data?.reason as string) ?? '对方取消了传输' });
        fileTransferStore.reset();
        serviceRef.current = null;
        setPhase('idle');
        setIncoming(null);
        break;
    }
  };
  useWsMessage(handleWs);

  const pct = progress.total > 0 ? Math.floor((progress.done / progress.total) * 100) : 0;

  // ─── 渲染 ────────────────────────────────────────────
  const ProgressBar = () => (
    <div className="space-y-1">
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full bg-[#19c8b9] transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs opacity-60">
        {formatFileSize(progress.done)} / {formatFileSize(progress.total)} ({pct}%)
      </p>
    </div>
  );

  if (!peerJoined) {
    return (
      <div className="text-center py-6">
        <Upload size={32} className="mx-auto text-[#c4b89e] mb-2" />
        <p className="text-sm text-[#725d42] mb-1">文件传输模式</p>
        <p className="text-xs opacity-50">等待对方加入后开始</p>
      </div>
    );
  }

  // 传输中（双方共用）
  if (phase === 'transferring') {
    return (
      <div className="py-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-[#725d42]">
          {role === 'host' ? <Upload size={18} /> : <Download size={18} />}
          <span>{role === 'host' ? '正在发送…' : '正在接收…'}</span>
        </div>
        <ProgressBar />
        <p className="text-[10px] opacity-40">
          {(role === 'host' ? transferMode : incoming?.transferMode) === 'stream'
            ? '流式传输：缓存一点即可边下边看，正在进入播放页…'
            : '完整传输：接收完成后自动进入播放'}
        </p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="text-center py-6 space-y-3">
        <p className="text-sm text-red-500">传输出错</p>
        <p className="text-xs opacity-50">P2P 连接中断或被拒绝，请重试</p>
        <Button size="small" type="default" onClick={() => { fileTransferStore.reset(); serviceRef.current = null; navigatedRef.current = false; setPhase('idle'); }}>
          重试
        </Button>
      </div>
    );
  }

  // 房主视角
  if (role === 'host') {
    const canStream = selectedFile ? MseStreamController.canStream(selectedFile.name, selectedFile.type) : false;
    return (
      <div className="py-4 space-y-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.webm,.m4v,.mov,.mkv"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handlePickFile(f); e.target.value = ''; }}
        />

        {!selectedFile ? (
          <div
            className="border-2 border-dashed border-[#c4b89e] hover:border-[#19c8b9] rounded-xl p-6 text-center cursor-pointer transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <FileVideo size={32} className="mx-auto text-[#c4b89e] mb-2" />
            <p className="text-sm text-[#725d42]">点击选择要发送的视频</p>
            <p className="text-xs opacity-50 mt-1">{FORMAT_HINT}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 p-3 bg-white/50 rounded-lg">
              <FileVideo size={24} className="text-[#19c8b9] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[#794f27] truncate">{selectedFile.name}</p>
                <p className="text-xs opacity-60">{formatFileSize(selectedFile.size)}</p>
              </div>
              {phase === 'idle' && (
                <Button size="small" type="default" onClick={() => fileInputRef.current?.click()}>重选</Button>
              )}
            </div>

            {/* 子模式选择 */}
            <div className="space-y-2">
              <button
                onClick={() => canStream && setTransferMode('stream')}
                disabled={!canStream}
                className={`w-full flex items-start gap-2 p-2.5 rounded-xl border-2 text-left transition-all ${
                  transferMode === 'stream' ? 'border-[#19c8b9] bg-[#f0faf9]' : 'border-gray-200'
                } ${!canStream ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <Zap size={18} className={transferMode === 'stream' ? 'text-[#19c8b9]' : 'text-gray-400'} />
                <div>
                  <p className="text-sm font-medium">流式播放</p>
                  <p className="text-[10px] opacity-50">
                    {canStream ? '边传边看，缓存一点即可开始' : '该格式（如 MKV）不支持流式，请用完整传输'}
                  </p>
                </div>
              </button>
              <button
                onClick={() => setTransferMode('complete')}
                className={`w-full flex items-start gap-2 p-2.5 rounded-xl border-2 text-left transition-all ${
                  transferMode === 'complete' ? 'border-[#19c8b9] bg-[#f0faf9]' : 'border-gray-200'
                }`}
              >
                <Download size={18} className={transferMode === 'complete' ? 'text-[#19c8b9]' : 'text-gray-400'} />
                <div>
                  <p className="text-sm font-medium">完整传输</p>
                  <p className="text-[10px] opacity-50">完整传给对方，收齐后一起播放（画质最稳）</p>
                </div>
              </button>
            </div>

            {phase === 'offering' ? (
              <p className="text-xs text-center opacity-50 animate-pulse py-2">已发出邀请，等待对方接收…</p>
            ) : (
              <Button type="primary" size="large" block onClick={handleSendOffer}>
                <Play size={16} className="mr-1 inline" />
                发送给对方
              </Button>
            )}
          </>
        )}
      </div>
    );
  }

  // 对方视角
  if (incoming) {
    const willStream = incoming.transferMode === 'stream' && MseStreamController.canStream(incoming.name, incoming.type);
    return (
      <div className="py-4 space-y-3">
        <div className="flex items-center gap-3 p-3 bg-white/50 rounded-lg">
          <FileVideo size={24} className="text-[#19c8b9] shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[#794f27] truncate">{incoming.name}</p>
            <p className="text-xs opacity-60">{formatFileSize(incoming.size)}</p>
          </div>
        </div>
        <p className="text-xs opacity-60 text-center">
          房主要发送这个视频给你 · {willStream ? '流式播放（边下边看）' : '完整传输（下完再看）'}
        </p>
        <Button type="primary" size="large" block onClick={() => void startGuestReceive(incoming)}>
          <Download size={16} className="mr-1 inline" />
          接收并观看
        </Button>
      </div>
    );
  }

  return (
    <div className="text-center py-6">
      <Download size={32} className="mx-auto text-[#c4b89e] mb-2" />
      <p className="text-sm text-[#725d42] mb-1">等待房主发送文件…</p>
      <p className="text-xs opacity-50">房主选好视频后你会收到接收提示</p>
    </div>
  );
}
