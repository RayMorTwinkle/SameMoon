import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Button, Card, Title, Notification } from 'animal-island-ui';
import { useWebSocket, useWsMessage } from '../../hooks/useWebSocket';
import { isValidVideoFile, FORMAT_HINT } from '../../utils/fileValidator';
import { formatFileSize } from '../../utils/formatFileSize';
import { setSharedFile } from '../../services/room/fileStore';
import { Link, UserPlus, FileVideo, CheckCircle, XCircle, Clock } from 'lucide-react';

type PeerStatus = 'waiting' | 'joined';
type FileMatchStatus = 'idle' | 'sent' | 'matched' | 'mismatched';

interface RoomNavState {
  role?: 'host' | 'guest';
  peerCount?: number;
}

export function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navState = (location.state as RoomNavState | null) ?? null;

  const [role, setRole] = useState<'host' | 'guest' | null>(navState?.role ?? null);
  const [peerStatus, setPeerStatus] = useState<PeerStatus>(
    (navState?.peerCount ?? 0) > 0 ? 'joined' : 'waiting'
  );
  const [copied, setCopied] = useState(false);
  const joinSentRef = useRef(false);
  const { status, send } = useWebSocket();

  // 文件选择相关状态
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [matchStatus, setMatchStatus] = useState<FileMatchStatus>('idle');
  const [matchDiff, setMatchDiff] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    const data = msg.data as Record<string, unknown>;

    switch (msg.type) {
      case 'room:joined':
        setRole((data.role as 'host' | 'guest') ?? 'guest');
        setPeerStatus(((data.peerCount as number) ?? 0) > 0 ? 'joined' : 'waiting');
        break;

      case 'room:peer-joined':
        setPeerStatus('joined');
        Notification.success({
          message: '对方已加入',
          description: '可以开始选择电影文件了',
        });
        break;

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

      case 'error':
        Notification.error({
          message: '出错了',
          description: (data.message as string) || '请稍后重试',
        });
        navigate('/');
        break;
    }
  }, [navigate]);

  useWsMessage(handleMessage);

  // 仅当直接通过 URL 进入（无路由 state 角色）时才自动 join
  // Fix R12: 重连后 status 重新变为 connected 时允许重新 join
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasDisconnected = prevStatusRef.current !== 'connected';
    prevStatusRef.current = status;

    if (status === 'connected' && code && !role) {
      // 首次进入或重连后都重新 join（服务端幂等，不会重复加入）
      if (!joinSentRef.current || wasDisconnected) {
        joinSentRef.current = true;
        send({ type: 'room:join', data: { roomCode: code } });
      }
    }
  }, [status, code, role, send]);

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/room/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      Notification.error({ message: '复制失败', description: '请手动复制链接' });
    }
  };

  // 文件选择处理
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
    send({ type: 'file:info', data: { name: file.name, size: file.size } });
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    // 清空 input 以便重复选择同一文件
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); // 必须！否则 drop 不触发
    setDragOver(true);
  };

  const handleReselect = () => {
    setSelectedFile(null);
    setMatchStatus('idle');
    setMatchDiff(null);
    fileInputRef.current?.click();
  };

  const peerJoined = peerStatus === 'joined';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <Title size="medium" color="app-green">
        等待室
      </Title>

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

      {/* 文件选择区（对方加入后激活） */}
      <Card color="app-pink" className="mt-4 max-w-sm w-full">
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.webm,.m4v,.mov,.mkv"
          className="hidden"
          onChange={handleInputChange}
        />

        {!peerJoined ? (
          <p className="text-center text-xs opacity-40 py-4">
            等待对方加入后，双方各自选择同一部电影
          </p>
        ) : matchStatus === 'idle' ? (
          /* 拖拽/点击选择区 */
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
          /* 已选择文件 → 显示文件信息 + 匹配状态 */
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

            {/* 匹配状态 */}
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
      </Card>

      {/* 匹配成功后的下一步 */}
      {matchStatus === 'matched' && (
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

      {/* 连接状态 */}
      <div className="mt-4 flex items-center gap-2 text-xs opacity-50">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            status === 'connected' ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'
          }`}
        />
        <span>
          {status === 'connected' ? '已连接' : status === 'reconnecting' ? '重连中…' : '连接中…'}
        </span>
      </div>
    </div>
  );
}
