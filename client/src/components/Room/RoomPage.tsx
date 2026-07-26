import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Card, Title, Notification } from 'animal-island-ui';
import { useWebSocket, useWsMessage } from '../../hooks/useWebSocket';
import { Link, UserPlus } from 'lucide-react';

type PeerStatus = 'waiting' | 'joined';

export function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [peerStatus, setPeerStatus] = useState<PeerStatus>('waiting');
  const [role, setRole] = useState<'host' | 'guest' | null>(null);
  const [copied, setCopied] = useState(false);
  const { status, send } = useWebSocket();

  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    const data = msg.data as Record<string, unknown>;

    switch (msg.type) {
      case 'room:created':
        setRole('host');
        break;

      case 'room:joined':
        setRole('guest');
        setPeerStatus('joined');
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
        Notification.warning({
          message: '对方已离开',
          description: '等待对方重新加入…',
        });
        break;

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

  // 通过 URL 进入时自动加入房间（非房主）
  useEffect(() => {
    if (status === 'connected' && code && !role) {
      send({ type: 'room:join', data: { roomCode: code } });
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

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <Title size="medium" color="app-green">
        等待室
      </Title>

      <Card color="app-yellow" className="mt-6 max-w-sm w-full">
        {/* 房间号 */}
        <div className="text-center">
          <p className="text-xs opacity-60 mb-1">房间号</p>
          <p className="text-4xl font-bold tracking-[0.3em] text-[#794f27]">
            {code}
          </p>
        </div>

        {/* 链接分享 */}
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
                peerStatus === 'joined'
                  ? 'border-green-400 bg-green-50'
                  : 'border-dashed border-gray-300 bg-gray-50'
              }`}
            >
              {peerStatus === 'joined' ? (
                <span className="text-green-600 text-sm font-bold">TA</span>
              ) : (
                <UserPlus size={18} className="text-gray-400" />
              )}
            </div>
            <span className={`text-xs ${peerStatus === 'joined' ? 'text-green-700' : 'text-gray-400'}`}>
              {peerStatus === 'joined' ? '已加入' : '等待加入…'}
            </span>
          </div>
        </div>
      </Card>

      {/* 下一步提示 */}
      <div className="mt-6 max-w-sm w-full">
        {peerStatus === 'joined' ? (
          <Button type="primary" size="large" block disabled>
            选择电影文件（下一步实现）
          </Button>
        ) : (
          <p className="text-center text-xs opacity-40">
            等待对方加入后，双方各自选择同一部电影
          </p>
        )}
      </div>

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
