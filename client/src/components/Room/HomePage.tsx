import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Title, Input, Notification } from 'animal-island-ui';
import { useWebSocket, useWsMessage } from '../../hooks/useWebSocket';

export function HomePage() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState('');
  const { status, send, restoredData } = useWebSocket();
  const restoredHandledRef = useRef(false);

  // 收到 session:restored 后自动跳转到房间页（仅首次）
  useEffect(() => {
    if (restoredData && !restoredHandledRef.current) {
      restoredHandledRef.current = true;
      navigate(`/room/${restoredData.roomCode}`, {
        state: { role: restoredData.role, peerCount: restoredData.peerOnline ? 1 : 0 },
        replace: true,
      });
    }
  }, [restoredData, navigate]);

  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    const data = msg.data as Record<string, unknown>;

    if (msg.type === 'room:created') {
      navigate(`/room/${data.roomCode}`, { state: { role: 'host' } });
      return;
    }

    if (msg.type === 'room:joined') {
      navigate(`/room/${msg.room}`, {
        state: { role: data.role ?? 'guest', peerCount: data.peerCount ?? 1 },
      });
      return;
    }

    if (msg.type === 'error') {
      const code = data.code as string | undefined;
      if (code === 'ALREADY_IN_ROOM') {
        Notification.warning({
          message: '你还在之前的房间里',
          description: '请点击下方「重置连接」清除旧会话，或直接关闭页面重开',
        });
        return;
      }
      Notification.error({
        message: '操作失败',
        description: (data.message as string) || '请稍后重试',
      });
    }
  }, [navigate]);

  useWsMessage(handleMessage);

  const handleCreate = () => {
    if (status !== 'connected') {
      Notification.info({
        message: '正在连接服务器…',
        description: status === 'reconnecting' ? '重连中，请稍等' : '请等待连接建立',
      });
      return;
    }
    send({ type: 'room:create', data: {} });
  };

  const handleJoin = () => {
    if (status !== 'connected') {
      Notification.info({ message: '正在连接服务器…', description: '请等待连接建立' });
      return;
    }
    if (roomCode.length !== 4) return;
    send({ type: 'room:join', data: { roomCode } });
  };

  // 重置连接：清除旧 session，强制全新开始
  const handleResetSession = () => {
    sessionStorage.removeItem('sm-session');
    restoredHandledRef.current = false;
    window.location.reload();
  };

  const connected = status === 'connected';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <Title size="large" color="app-green">
        Same Moon
      </Title>
      <p className="mt-2 text-sm opacity-60">千里共婵娟 · 异地同步观影</p>

      <Card color="app-blue" className="mt-8 max-w-sm w-full">
        <div className="flex flex-col gap-4">
          <Button
            type="primary"
            size="large"
            block
            disabled={!connected}
            onClick={handleCreate}
          >
            创建房间
          </Button>

          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Input
                placeholder="输入4位房间号"
                value={roomCode}
                maxLength={4}
                onChange={(e) => setRoomCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
              />
            </div>
            <Button
              type="default"
              disabled={!connected || roomCode.length !== 4}
              onClick={handleJoin}
            >
              加入
            </Button>
          </div>
        </div>
      </Card>

      {/* 连接状态 */}
      <div className="mt-6 flex items-center gap-2 text-xs opacity-50">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            connected ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'
          }`}
        />
        <span>
          {status === 'connected' && '已连接'}
          {status === 'connecting' && '连接中…'}
          {status === 'reconnecting' && '重连中…'}
          {status === 'disconnected' && '已断开'}
        </span>
      </div>

      {/* 重置连接入口 */}
      <button
        className="mt-4 text-xs opacity-30 hover:opacity-60 transition-opacity underline"
        onClick={handleResetSession}
      >
        重置连接（清除旧会话）
      </button>
    </div>
  );
}
