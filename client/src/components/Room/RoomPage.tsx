import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Button, Card, Title, Notification } from 'animal-island-ui';
import { useWebSocket, useWsMessage } from '../../hooks/useWebSocket';
import { isValidVideoFile, FORMAT_HINT } from '../../utils/fileValidator';
import { formatFileSize } from '../../utils/formatFileSize';
import { setSharedFile } from '../../services/room/fileStore';
import { debugStore } from '../../services/debugStore';
import { Link, UserPlus, FileVideo, CheckCircle, XCircle, Clock, Home, ArrowLeft, RefreshCw, Monitor, Upload, StopCircle } from 'lucide-react';
import { ScreenShareService, QUALITY_LABELS, type QualityPreset, type ScreenShareState } from '../../services/webrtc/ScreenShare';
import { screenShareStore } from '../../services/webrtc/screenShareStore';
import { ConnectionStats } from '../common/ConnectionStats';

type PeerStatus = 'waiting' | 'joined';
type FileMatchStatus = 'idle' | 'sent' | 'matched' | 'mismatched';
type RoomMode = 'local-sync' | 'file-transfer' | 'screen-share';

const MODE_LABELS: Record<RoomMode, string> = {
  'local-sync': '本地同步',
  'file-transfer': '文件传输',
  'screen-share': '屏幕分享',
};

interface RoomNavState {
  role?: 'host' | 'guest';
  peerCount?: number;
  mode?: RoomMode;
}

// 屏幕采集能力检测：手机浏览器（Android Edge/Chrome/iOS Safari）均未实现 getDisplayMedia，
// 按钮点了没反应就是因为调用直接抛异常——平台限制，与 HTTPS/flags 无关
const canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

// 胶囊按钮样式（画质/帧率/音质选择器复用）
const chipCls = (active: boolean) =>
  `px-2 py-0.5 text-xs rounded-full border transition-colors ${
    active ? 'bg-[#19c8b9] text-white border-[#19c8b9]' : 'border-gray-200 text-gray-500 hover:border-[#19c8b9]'
  }`;

export function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navState = (location.state as RoomNavState | null) ?? null;

  const [role, setRole] = useState<'host' | 'guest' | null>(navState?.role ?? null);
  const [roomMode, setRoomMode] = useState<RoomMode>(navState?.mode ?? 'local-sync');
  const [peerStatus, setPeerStatus] = useState<PeerStatus>(
    (navState?.peerCount ?? 0) > 0 ? 'joined' : 'waiting'
  );
  const [copied, setCopied] = useState(false);
  const joinSentRef = useRef(false);
  const { status, send, restoredData } = useWebSocket();

  // 文件选择相关状态
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [matchStatus, setMatchStatus] = useState<FileMatchStatus>('idle');
  const [matchDiff, setMatchDiff] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [roomClosed, setRoomClosed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── 屏幕分享状态 ─────────────────────────────────────
  const [screenShareState, setScreenShareState] = useState<ScreenShareState>('idle');
  const [screenShareBusy, setScreenShareBusy] = useState(false);
  const screenRef = useRef<ScreenShareService | null>(null);
  // 分享中的质量调节状态（与 ScreenShare.ts 默认值一致）
  const [videoQuality, setVideoQuality] = useState<QualityPreset>('balanced');
  const [shareFps, setShareFps] = useState(30);
  const [audioKbps, setAudioKbps] = useState(128);

  // 重连带出上次文件名（用于提示用户）
  const [restoreFileName, setRestoreFileName] = useState<string | null>(null);
  const [restoreFileSize, setRestoreFileSize] = useState<number | null>(null);

  // 刻意不用 useCallback：useWsMessage 每次渲染更新 handlerRef，普通函数保证
  // 闭包读到最新 roomMode 等 state（修复 stale closure 导致 rtc:signal 首个 offer 被丢弃）
  const handleMessage = (msg: Record<string, unknown>) => {
    const data = msg.data as Record<string, unknown>;

    switch (msg.type) {
      case 'room:joined':
        setRole((data.role as 'host' | 'guest') ?? 'guest');
        setPeerStatus(((data.peerCount as number) ?? 0) > 0 ? 'joined' : 'waiting');
        if (data.mode) {
          setRoomMode(data.mode as RoomMode);
          debugStore.setRoomInfo(data.mode as string, code ?? null);
        }
        break;

      case 'room:peer-joined':
        setPeerStatus('joined');
        debugStore.setPeerOnline(true);
        // 对方重连 → 文件已失效，重置匹配状态
        setMatchStatus('idle');
        setSelectedFile(null);
        setMatchDiff(null);
        Notification.info({
          message: '对方已重新加入',
          description: '需要重新选择文件进行验证',
        });
        break;

      case 'file:reset': {
        // 服务端通知：对方重连，fileInfo 已清除，需要重新验证
        setMatchStatus('idle');
        setMatchDiff(null);
        break;
      }

      case 'room:left':
        setPeerStatus('waiting');
        setMatchStatus('idle');
        Notification.warning({
          message: '对方已离开',
          description: '等待对方重新加入…',
        });
        break;

      case 'file:match': {
        const matched = data.matched as boolean;
        if (matched) {
          setMatchStatus('matched');
          setMatchDiff(null);
          Notification.success({
            message: '文件匹配成功',
            description: '双方文件一致，准备开始播放',
          });
        } else {
          setMatchStatus('mismatched');
          setMatchDiff((data.diff as string) ?? '文件信息不一致');
        }
        break;
      }

      case 'screen:grant':
        // 获权分享或对方开始分享
        setScreenShareBusy(false);
        break;

      case 'screen:busy':
        setScreenShareBusy(true);
        Notification.warning({ message: '屏幕分享被占用', description: `对方 (${data.sharer}) 正在分享中` });
        break;

      case 'screen:stop':
        screenRef.current?.stop();
        setScreenShareState('idle');
        setScreenShareBusy(false);
        break;

      case 'rtc:signal': {
        // ★ 统一信令：simple-peer 的 signal 事件
        const signalData = data;
        const sigType = (signalData as { type?: string })?.type ?? 'candidate';
        debugStore.log('rtc', 'signal-recv', sigType);

        // 1) 优先交给本组件的服务（内部带缓冲队列：peer 未建好时 candidate 入队不丢失）
        if (screenRef.current) {
          screenRef.current.signal(signalData);
          break;
        }
        // 2) 页面刷新等场景：服务不在但 store 里有 peer
        const existingPeer = screenShareStore.state.peer;
        if (existingPeer) {
          (existingPeer as any).signal(signalData);
          break;
        }
        // 3) 仅 offer 才启动观看流程（WS 有序，offer 必先于 candidate 到达；
        //    此前 candidate 也会误触发 handleIncomingShare，造成重复建 peer 的竞态——屏幕分享连不上的根因）
        if (sigType === 'offer' && roomMode === 'screen-share' && !screenShareStore.isSharer()) {
          console.log('[SS-B] 收到 offer, 启动 handleIncomingShare');
          handleIncomingShare(signalData);
        } else {
          debugStore.logError('rtc', 'signal-dropped', `无 peer 可路由: ${sigType}`);
        }
        break;
      }

      case 'error': {
        const errCode = (data.code as string) ?? '';
        debugStore.logError('room', 'server-error', `${errCode}: ${data.message}`);
        if (errCode === 'ROOM_NOT_FOUND') {
          setRoomClosed(true);
          break;
        }
        Notification.error({
          message: '出错了',
          description: (data.message as string) || '请稍后重试',
        });
        // 仅明确的致命错误才离开房间（此前任何未知错误都会把用户踢回首页）
        if (errCode === 'INVALID_ROOM' || errCode === 'SERVER_FULL') {
          navigate('/');
        }
        break;
      }
    }
  };

  useWsMessage(handleMessage);

  // TECH-SPEC §3.3: 重连恢复 — 从 session:restored 恢复房间状态
  const restoredActiveRef = useRef(false);
  useEffect(() => {
    if (restoredData && restoredData.roomCode === code) {
      restoredActiveRef.current = true;
      setRole(restoredData.role);
      setPeerStatus(restoredData.peerOnline ? 'joined' : 'waiting');
      const mode = (restoredData as { mode?: RoomMode }).mode ?? 'local-sync';
      setRoomMode(mode);
      debugStore.setRoomInfo(mode, code);
      debugStore.setPeerOnline(restoredData.peerOnline);
      // 保存上次文件名用于提示（服务端已清除 fileInfo，需要重新选择）
      if (restoredData.fileName) {
        setRestoreFileName(restoredData.fileName);
        setRestoreFileSize(restoredData.fileSize ?? null);
      }
      // 确保匹配状态是 idle（需要重新选文件验证）
      setMatchStatus('idle');
      setSelectedFile(null);
    }
  }, [restoredData, code]);

  // 自动 join（仅当无 restoredData 时才执行，防止竞态）
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasDisconnected = prevStatusRef.current !== 'connected';
    prevStatusRef.current = status;

    if (restoredActiveRef.current) return;

    if (status === 'connected' && code && !role) {
      if (!joinSentRef.current || wasDisconnected) {
        joinSentRef.current = true;
        send({ type: 'room:join', data: { roomCode: code } });
      }
    }
  }, [status, code, role, send]);

  const handleLeaveRoom = () => {
    if (window.confirm('确定要离开房间吗？')) {
      screenRef.current?.stop();
      // 清除 session + 整页跳转：彻底销毁 WS 连接与内存状态。
      // 此前用 navigate('/') 时 WS 仍持旧 sessionId、restoredData 仍在 Context 里，
      // 导致回首页后又被 session:restored 弹回房间
      sessionStorage.removeItem('sm-session');
      window.location.href = '/';
    }
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/room/${code}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // HTTP 环境降级：创建临时 textarea
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        Notification.error({ message: '复制失败', description: '请手动复制链接' });
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ─── 屏幕分享 ────────────────────────────────────────

  const handleShare = async () => {
    console.log('[SS-A] handleShare 开始');
    const svc = new ScreenShareService();
    screenRef.current = svc;
    svc.onStateChangeHandler(setScreenShareState);
    send({ type: 'screen:request', data: {} });
    console.log('[SS-A] screen:request 已发送');
    try {
      await svc.startSharing((data) => send({ type: 'rtc:signal', data }));
      console.log('[SS-A] startSharing 完成, peer 已存入 store:', !!screenShareStore.state.peer);
      // ★ 分享方不跳转！保持在房间页显示"正在分享"
    } catch (err) {
      console.error('[SS-A] startSharing 失败:', err);
      Notification.error({ message: '分享失败', description: '请检查浏览器权限设置' });
      setScreenShareState('idle');
      send({ type: 'screen:stop', data: {} });
    }
  };

  const handleStopShare = () => {
    screenRef.current?.stop();
    setScreenShareState('idle');
    send({ type: 'screen:stop', data: {} });
  };

  const handleIncomingShare = async (signalData: unknown) => {
    console.log('[SS-B] handleIncomingShare 开始');
    const svc = new ScreenShareService();
    screenRef.current = svc;
    svc.onStateChangeHandler(setScreenShareState);
    try {
      await svc.startViewing(
        (data) => send({ type: 'rtc:signal', data }),
        signalData,
      );
      console.log('[SS-B] startViewing 完成');
      navigate(`/room/${code}/play`, { state: { mode: 'screen-share' } });
    } catch (err) {
      console.error('[SS-B] startViewing 失败:', err);
      Notification.error({ message: '连接失败', description: '无法建立 P2P 连接，请对方重新分享' });
      setScreenShareState('idle');
    }
  };

  const handleFileSelect = (file: File) => {
    if (!isValidVideoFile(file)) {
      Notification.error({
        message: '格式不支持',
        description: `${FORMAT_HINT}`,
      });
      return;
    }
    setSelectedFile(file);
    setMatchStatus('sent');
    setMatchDiff(null);
    setRestoreFileName(null);
    send({ type: 'file:info', data: { name: file.name, size: file.size } });
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleReselect = () => {
    setSelectedFile(null);
    setMatchStatus('idle');
    setMatchDiff(null);
    fileInputRef.current?.click();
  };

  const peerJoined = peerStatus === 'joined';

  // 房间已关闭
  if (roomClosed) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6">
        <Title size="large" color="app-green">
          房间已关闭
        </Title>
        <Card color="app-yellow" className="mt-6 max-w-sm w-full">
          <div className="text-center py-4">
            <p className="text-sm text-[#725d42] mb-2">
              房间 {code} 已关闭或不存在
            </p>
            <p className="text-xs opacity-60 mb-4">
              可能原因：双方都刷新了页面、房间超时无人加入、或服务器重启
            </p>
            <Button type="primary" size="large" block onClick={() => navigate('/')}>
              <Home size={18} className="mr-1 inline" />
              返回首页创建新房间
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <Title size="large" color="app-green">
        等待室
      </Title>
      <span className="mt-1 text-xs px-2 py-0.5 rounded-full bg-[#f0faf9] text-[#19c8b9] border border-[#19c8b9]/20">
        {MODE_LABELS[roomMode]}
      </span>

      {/* 房间号 + 链接 */}
      <Card color="app-yellow" className="mt-6 max-w-sm w-full">
        <div className="text-center">
          <p className="text-xs opacity-60 mb-1">房间号</p>
          <p className="text-4xl font-bold tracking-[0.3em] text-[#794f27]">
            {code}
          </p>
        </div>
        <div className="mt-4 flex items-center gap-2 bg-white/50 rounded-lg p-3">
          <Link size={16} className="text-[#794f27] shrink-0" />
          <span className="text-xs truncate flex-1 opacity-70">
            {window.location.origin}/room/{code}
          </span>
          <Button size="small" type={copied ? 'primary' : 'default'} onClick={handleCopyLink}>
            {copied ? '已复制' : '复制'}
          </Button>
        </div>
        <p className="mt-3 text-xs text-center opacity-50">
          把链接发给 TA，TA 打开即可加入
        </p>
      </Card>

      {/* 用户状态 */}
      <Card color="app-blue" className="mt-4 max-w-sm w-full">
        <div className="flex justify-center gap-8">
          <div className="flex flex-col items-center gap-2">
            <div className="w-12 h-12 rounded-full border-2 border-green-400 bg-green-50 flex items-center justify-center">
              <span className="text-green-600 text-sm font-bold">
                {role === 'host' ? '房主' : '你'}
              </span>
            </div>
            <span className="text-xs text-green-700">已就绪</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <div
              className={`w-12 h-12 rounded-full border-2 flex items-center justify-center ${
                peerJoined
                  ? 'border-green-400 bg-green-50'
                  : 'border-dashed border-gray-300 bg-gray-50'
              }`}
            >
              {peerJoined ? (
                <span className="text-green-600 text-sm font-bold">TA</span>
              ) : (
                <UserPlus size={18} className="text-gray-400" />
              )}
            </div>
            <span className={`text-xs ${peerJoined ? 'text-green-700' : 'text-gray-400'}`}>
              {peerJoined ? '已加入' : '等待加入…'}
            </span>
          </div>
        </div>
      </Card>

      {/* 操作区 — 按模式分支 */}
      <Card color="app-pink" className="mt-4 max-w-sm w-full">
        {/* ── local-sync 模式：文件匹配（现有） ── */}
        {roomMode === 'local-sync' && (
          <>
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.webm,.m4v,.mov,.mkv"
          className="hidden"
          onChange={handleInputChange}
        />

        {/* 重连后提示重新选择文件 */}
        {restoreFileName && (
          <div className="flex items-center gap-2 bg-[#eff6ff] border border-[#3b82f6] rounded-lg p-3 mb-3">
            <RefreshCw size={16} className="text-blue-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-[#1e40af]">已恢复房间，请重新选择文件</p>
              <p className="text-[10px] text-[#3b82f6] truncate">
                上次选择：{restoreFileName}
                {restoreFileSize ? ` (${formatFileSize(restoreFileSize)})` : ''}
              </p>
            </div>
          </div>
        )}

        {!peerJoined ? (
          <p className="text-center text-xs opacity-40 py-4">
            等待对方加入后，双方各自选择同一部电影
          </p>
        ) : matchStatus === 'idle' ? (
          <div
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
              dragOver ? 'border-[#19c8b9] bg-[#e6f9f6]' : 'border-[#c4b89e] hover:border-[#19c8b9]'
            }`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={() => setDragOver(false)}
          >
            <FileVideo size={32} className="mx-auto text-[#c4b89e] mb-2" />
            <p className="text-sm text-[#725d42]">点击选择 或 拖拽文件到此处</p>
            <p className="text-xs opacity-50 mt-1">{FORMAT_HINT}</p>
            <p className="text-xs opacity-40 mt-2">文件不会上传，仅在你的设备上播放</p>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-3 p-3 bg-white/50 rounded-lg">
              <FileVideo size={24} className="text-[#19c8b9] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[#794f27] truncate">{selectedFile?.name}</p>
                <p className="text-xs opacity-60">{selectedFile ? formatFileSize(selectedFile.size) : ''}</p>
              </div>
              <Button size="small" type="default" onClick={handleReselect}>
                重选
              </Button>
            </div>

            <div className="mt-3 space-y-2">
              {matchStatus === 'sent' && (
                <div className="flex items-center gap-2 text-xs text-[#92400e] bg-[#fffbeb] rounded-lg p-2">
                  <Clock size={14} />
                  <span>已发送文件信息，等待对方选择…</span>
                </div>
              )}
              {matchStatus === 'matched' && (
                <div className="flex items-center gap-2 text-xs text-[#276749] bg-[#f0fff4] rounded-lg p-2">
                  <CheckCircle size={14} />
                  <span>文件匹配成功！双方文件一致</span>
                </div>
              )}
              {matchStatus === 'mismatched' && (
                <div className="text-xs text-[#c53030] bg-[#fff5f5] rounded-lg p-3">
                  <div className="flex items-center gap-2 font-medium mb-1">
                    <XCircle size={14} />
                    <span>文件不匹配</span>
                  </div>
                  <p className="opacity-80">{matchDiff}</p>
                  <p className="opacity-60 mt-1">请双方确认使用完全相同的文件（同一来源、同一版本）</p>
                  <Button size="small" type="default" className="mt-2" onClick={handleReselect}>
                    重新选择文件
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
        </>
        )}

        {/* ── file-transfer 模式（Step 3 实现） ── */}
        {roomMode === 'file-transfer' && (
          <div className="text-center py-6">
            <Upload size={32} className="mx-auto text-[#c4b89e] mb-2" />
            <p className="text-sm text-[#725d42] mb-1">文件传输模式</p>
            <p className="text-xs opacity-50">
              {role === 'host' ? '房主将选择一个文件传给对方' : '等待房主发送文件'}
            </p>
            <p className="text-[10px] opacity-30 mt-2">Step 3 实现</p>
          </div>
        )}

        {/* ── screen-share 模式 ── */}
        {roomMode === 'screen-share' && (
          <div className="text-center py-4 space-y-3">
            <Monitor size={32} className="mx-auto text-[#c4b89e]" />
            <p className="text-sm text-[#725d42]">屏幕分享模式</p>

            {screenShareState === 'running' ? (
              // 正在分享中
              <>
                <div className="flex items-center justify-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-red-500">正在分享</span>
                </div>
                {screenShareStore.isSharer() && (
                  <div className="space-y-2">
                    <ConnectionStats />
                    <div className="flex items-center gap-1 justify-center flex-wrap">
                      <span className="text-[10px] opacity-40">画质</span>
                      {(Object.keys(QUALITY_LABELS) as QualityPreset[]).map(p => (
                        <button key={p} className={chipCls(videoQuality === p)}
                          onClick={() => { setVideoQuality(p); void screenRef.current?.setVideoQuality(p); }}>
                          {QUALITY_LABELS[p]}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1 justify-center">
                      <span className="text-[10px] opacity-40">帧率</span>
                      {[15, 30, 60].map(f => (
                        <button key={f} className={chipCls(shareFps === f)}
                          onClick={() => { setShareFps(f); void screenRef.current?.setFrameRate(f); }}>
                          {f}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1 justify-center">
                      <span className="text-[10px] opacity-40">音质</span>
                      {[64, 128, 256].map(k => (
                        <button key={k} className={chipCls(audioKbps === k)}
                          onClick={() => { setAudioKbps(k); void screenRef.current?.setAudioBitrate(k * 1000); }}>
                          {k}k
                        </button>
                      ))}
                    </div>
                    <Button type="default" size="large" onClick={handleStopShare}
                      icon={<StopCircle size={16} />}>
                      停止分享
                    </Button>
                  </div>
                )}
                {screenShareStore.isViewer() && (
                  <Button type="primary" size="large"
                    onClick={() => navigate(`/room/${code}/play`, { state: { mode: 'screen-share' } })}>
                    观看屏幕
                  </Button>
                )}
              </>
            ) : screenShareState === 'requesting' ? (
              <p className="text-xs opacity-50 animate-pulse">正在建立连接…</p>
            ) : (
              // 空闲：显示分享按钮
              <>
                <p className="text-xs opacity-50">
                  {peerJoined
                    ? '点击开始分享你的屏幕，对方将实时观看'
                    : '等待对方加入后即可开始'}
                </p>
                {peerJoined && !screenShareBusy && (
                  canShareScreen ? (
                    <Button type="primary" size="large" onClick={handleShare}>
                      分享我的屏幕
                    </Button>
                  ) : (
                    <p className="text-xs text-yellow-600 px-4">
                      当前浏览器不支持屏幕采集（手机端 Edge/Chrome/Safari 均未开放此 API），
                      只能观看对方分享。请用电脑端发起分享
                    </p>
                  )
                )}
                {screenShareBusy && (
                  <p className="text-xs text-yellow-600">对方正在分享，请先等待结束</p>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      {/* 匹配成功后的下一步（仅 local-sync） */}
      {roomMode === 'local-sync' && matchStatus === 'matched' && (
        <div className="mt-4 max-w-sm w-full">
          <Button type="primary" size="large" block onClick={() => {
            if (selectedFile) {
              setSharedFile(selectedFile);
              navigate(`/room/${code}/play`);
            }
          }}>
            进入播放
          </Button>
        </div>
      )}

      {/* 连接状态 + 操作 */}
      <div className="mt-4 flex items-center justify-between px-2 w-full max-w-sm">
        <div className="flex items-center gap-2 text-xs opacity-50">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              status === 'connected' ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'
            }`}
          />
          <span>
            {status === 'connected' ? '已连接' : status === 'reconnecting' ? '重连中…' : '连接中…'}
          </span>
        </div>
        <button
          className="flex items-center gap-1 text-xs opacity-50 hover:opacity-80 transition-opacity"
          onClick={handleLeaveRoom}
        >
          <ArrowLeft size={12} />
          离开房间
        </button>
      </div>
    </div>
  );
}
