import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Title, Input, Notification } from 'animal-island-ui';
import { useWebSocket, useWsMessage } from '../../hooks/useWebSocket';
import { FileVideo, Monitor, Users, Check } from 'lucide-react';

type RoomMode = 'local-sync' | 'file-transfer' | 'screen-share';

const MODE_OPTIONS: { mode: RoomMode; label: string; desc: string; icon: typeof Users; color: string }[] = [
  { mode: 'local-sync', label: '本地同步', desc: '各自打开同名、同大小的影片，一起播放', icon: Users, color: 'var(--sm-mode-local)' },
  { mode: 'file-transfer', label: '文件传输', desc: '只有一份影片？由房主传给对方', icon: FileVideo, color: 'var(--sm-mode-file)' },
  { mode: 'screen-share', label: '屏幕分享', desc: '从电脑分享屏幕，对方直接观看', icon: Monitor, color: 'var(--sm-mode-screen)' },
];

/** 手绘月亮标记：柔光 + 缓慢浮动 + 一颗薄荷星 */
function MoonMark() {
  return (
    <div className="sm-float" aria-hidden>
      <svg width="66" height="66" viewBox="0 0 66 66" fill="none">
        <defs>
          <radialGradient id="sm-moon-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffe9a8" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#ffe9a8" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="33" cy="33" r="30" fill="url(#sm-moon-glow)" />
        <path
          d="M42 15a19 19 0 1 0 9 25.5A15.5 15.5 0 0 1 42 15z"
          fill="#f7cd67"
          stroke="#e0b800"
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
        <circle cx="31" cy="35" r="3" fill="#e8b94e" opacity="0.55" />
        <circle cx="25" cy="27" r="2" fill="#e8b94e" opacity="0.45" />
        <path d="M53 17l1.3 3.2 3.2 1.3-3.2 1.3L53 26l-1.3-3.2-3.2-1.3 3.2-1.3z" fill="#19c8b9" />
      </svg>
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState('');
  const [mode, setMode] = useState<RoomMode>('local-sync');
  const { status, send, restoredData } = useWebSocket();
  const restoredHandledRef = useRef(false);

  // 收到 session:restored 后自动跳转到房间页（仅首次）
  useEffect(() => {
    if (restoredData && !restoredHandledRef.current) {
      restoredHandledRef.current = true;
      navigate(`/room/${restoredData.roomCode}`, {
        state: {
          role: restoredData.role,
          peerCount: restoredData.peerOnline ? 1 : 0,
          mode: (restoredData as { mode?: string }).mode ?? 'local-sync',
        },
        replace: true,
      });
    }
  }, [restoredData, navigate]);

  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    const data = msg.data as Record<string, unknown>;

    if (msg.type === 'room:created') {
      navigate(`/room/${data.roomCode}`, { state: { role: 'host', mode: data.mode ?? 'local-sync' } });
      return;
    }

    if (msg.type === 'room:joined') {
      navigate(`/room/${msg.room}`, {
        state: { role: data.role ?? 'guest', peerCount: data.peerCount ?? 1, mode: data.mode ?? 'local-sync' },
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
    send({ type: 'room:create', data: { mode } });
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
  const statusLabel =
    status === 'connected' ? '已连接' :
    status === 'connecting' ? '连接中…' :
    status === 'reconnecting' ? '重连中…' : '已断开';

  return (
    <div className="min-h-screen flex flex-col items-center px-5 py-10">
      {/* 顶部标识 */}
      <div className="sm-fade-up flex flex-col items-center">
        <MoonMark />
        <div className="mt-1">
          <Title size="large" color="app-green">Same Moon</Title>
        </div>
        <p className="mt-2 text-sm font-medium sm-t-sec">和 TA 隔着屏幕，一起看</p>
      </div>

      {/* 主面板 */}
      <div className="sm-panel sm-fade-up mt-7 w-full max-w-sm p-5" style={{ animationDelay: '70ms' }}>
        {/* ① 创建 */}
        <p className="text-sm font-bold sm-t">想和 TA 怎么看？</p>
        <p className="text-xs sm-t-sec mt-0.5 mb-3">选一种方式，创建房间后把链接发给 TA</p>

        <div className="grid gap-2.5">
          {MODE_OPTIONS.map((opt, i) => {
            const Icon = opt.icon;
            const selected = mode === opt.mode;
            return (
              <button
                key={opt.mode}
                type="button"
                aria-pressed={selected}
                onClick={() => setMode(opt.mode)}
                className={`sm-mode-card sm-fade-up ${selected ? 'sm-mode-card--active' : ''}`}
                style={{ animationDelay: `${120 + i * 70}ms` }}
              >
                <span className="sm-icon-badge" style={{ background: selected ? 'var(--sm-primary)' : opt.color }}>
                  <Icon size={22} strokeWidth={2.4} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-bold sm-t">{opt.label}</span>
                  <span className="block text-xs sm-t-sec mt-0.5 leading-snug">{opt.desc}</span>
                </span>
                {selected && (
                  <span className="sm-check">
                    <Check size={15} strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <Button
          type="primary"
          size="large"
          block
          disabled={!connected}
          onClick={handleCreate}
          className="mt-5"
        >
          创建房间
        </Button>

        {/* 分隔：加入 */}
        <div className="flex items-center gap-3 my-5">
          <span className="flex-1 h-px" style={{ background: 'var(--sm-border)' }} />
          <span className="text-xs sm-t-sec whitespace-nowrap">或加入 TA 的房间</span>
          <span className="flex-1 h-px" style={{ background: 'var(--sm-border)' }} />
        </div>

        {/* ② 加入 */}
        <form className="flex items-center gap-2" onSubmit={(event) => {
          event.preventDefault();
          handleJoin();
        }}>
          <div className="flex-1 min-w-0">
            <Input
              aria-label="4 位房间号"
              placeholder="输入 4 位房间号"
              value={roomCode}
              inputMode="numeric"
              onChange={(e) => setRoomCode((e.target as HTMLInputElement).value.normalize('NFKC').replace(/\D/g, '').slice(0, 4))}
            />
          </div>
          <Button
            type="default"
            size="large"
            disabled={!connected || roomCode.length !== 4}
            htmlType="submit"
          >
            加入
          </Button>
        </form>
      </div>

      {/* 连接状态 */}
      <div className="sm-fade-up mt-7" style={{ animationDelay: '360ms' }}>
        <div className="sm-pill" role="status" aria-live="polite">
          <span
            className="sm-dot"
            style={{
              background: connected ? 'var(--sm-success)' : 'var(--sm-warning)',
              animation: connected ? 'none' : 'sm-glow 1.2s infinite',
            }}
          />
          <span>{statusLabel}</span>
        </div>
      </div>

      {/* 重置连接入口 */}
      <button
        className="mt-4 text-xs sm-t-muted hover:sm-t-body transition-opacity"
        style={{ background: 'none', border: 'none', cursor: 'pointer' }}
        onClick={handleResetSession}
      >
        重置连接（清除旧会话）
      </button>
    </div>
  );
}
