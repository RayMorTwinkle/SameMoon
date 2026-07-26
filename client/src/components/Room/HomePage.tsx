import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Title, Input, Notification } from 'animal-island-ui';
import { useWebSocket } from '../hooks/useWebSocket';

export function HomePage() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState('');
  const [joining, setJoining] = useState(false);
  const pendingAction = useRef<'create' | 'join' | null>(null);

  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    const data = msg.data as Record<string, unknown>;

    if (msg.type === 'room:created') {
      navigate(`/room/${data.roomCode}`);
    }

    if (msg.type === 'room:joined') {
      navigate(`/room/${msg.room}`);
    }

    if (msg.type === 'error') {
      setJoining(false);
      Notification.error({
        message: '操作失败',
        description: (data.message as string) || '请稍后重试',
      });
    }
  }, [navigate]);

  const { status, send } = useWebSocket({ onMessage: handleMessage });

  const handleCreate = () => {
    if (status !== 'connected') return;
    pendingAction.current = 'create';
    send({ type: 'room:create', data: {} });
  };

  const handleJoin = () => {
    if (status !== 'connected' || roomCode.length !== 4) return;
    setJoining(true);
    pendingAction.current = 'join';
    send({ type: 'room:join', data: { roomCode } });
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
                onChange={(v: string) => setRoomCode(v.replace(/\D/g, ''))}
              />
            </div>
            <Button
              type="default"
              disabled={!connected || roomCode.length !== 4 || joining}
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
    </div>
  );
}
