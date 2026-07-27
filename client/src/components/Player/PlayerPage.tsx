import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Card, Notification } from 'animal-island-ui';
import { useWebSocket, useWsMessage } from '../../hooks/useWebSocket';
import { getSharedFile } from '../../services/room/fileStore';
import { LocalFileAdapter } from '../../services/playback/LocalFileAdapter';
import { ClockSync } from '../../services/sync/ClockSync';
import { SyncEngine } from '../../services/sync/SyncEngine';
import { Play, Wifi, WifiOff } from 'lucide-react';

type Phase = 'loading' | 'ready-prompt' | 'syncing';

export function PlayerPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { status, send, userId } = useWebSocket();

  const [phase, setPhase] = useState<Phase>('loading');
  const [peerReady, setPeerReady] = useState(false);
  const [syncStatus] = useState<'synced' | 'drifting' | 'buffering'>('synced');

  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<LocalFileAdapter | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const clockRef = useRef(new ClockSync());

  // 初始化播放器
  useEffect(() => {
    const file = getSharedFile();
    if (!file || !containerRef.current) {
      navigate(`/room/${code}`);
      return;
    }

    const adapter = new LocalFileAdapter(containerRef.current);
    adapterRef.current = adapter;

    adapter.load({ kind: 'local-file', file }).then(() => {
      setPhase('ready-prompt');
    }).catch(() => {
      Notification.error({ message: '文件加载失败', description: '请确认文件未损坏' });
      navigate(`/room/${code}`);
    });

    return () => {
      engineRef.current?.stop();
      adapter.destroy();
    };
  }, [code, navigate]);

  // 处理远端消息
  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    // sync:* 消息全部交给引擎处理（心跳双向握手已在引擎内部完成）
    if ((msg.type as string).startsWith('sync:')) {
      engineRef.current?.handleRemoteMessage(msg);
      return;
    }
  
    // 对方点击“准备好了”
    if (msg.type === 'player:ready') {
      setPeerReady(true);
    }
  
    if (msg.type === 'room:left') {
      Notification.warning({ message: '对方已离开', description: '同步已暂停' });
      engineRef.current?.stop();
    }
  }, []);

  useWsMessage(handleMessage);

  // "准备好了"按钮（TECH-SPEC §2.4 自动播放授权）
  const handleReady = async () => {
    const adapter = adapterRef.current;
    if (!adapter) return;

    try {
      // 消耗用户手势，解锁程序化 play() 权限
      await adapter.play();
      adapter.pause();
    } catch {
      Notification.error({
        message: '播放权限被拒绝',
        description: '请点击视频画面手动开始播放',
      });
    }

    // 通知对方自己已就绪
    send({ type: 'player:ready', data: {} });

    // 如果对方也已就绪 → 启动同步引擎
    if (peerReady) {
      startSync();
    } else {
      setPhase('syncing'); // 先显示播放器，等对方 ready 后自动开始
    }
  };

  // 对方 ready 后如果自己也 ready → 启动同步
  useEffect(() => {
    if (peerReady && phase === 'syncing' && !engineRef.current) {
      startSync();
    }
  }, [peerReady, phase]);

  const startSync = () => {
    const adapter = adapterRef.current;
    if (!adapter || !userId) return;

    const transport = { send: (msg: Record<string, unknown>) => send(msg) };
    const engine = new SyncEngine({
      adapter,
      transport,
      clockSync: clockRef.current,
      userId,
    });
    engineRef.current = engine;
    engine.start();

    // 请求对方全量状态追齐
    engine.requestState();
    setPhase('syncing');
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 pt-6">
      {/* 播放器容器 */}
      <div className="w-full max-w-3xl">
        <div
          ref={containerRef}
          className="w-full aspect-video bg-black rounded-xl overflow-hidden"
        />
      </div>

      {/* 准备/同步控制区 */}
      <div className="w-full max-w-3xl mt-4">
        {phase === 'ready-prompt' && (
          <Card color="app-green" className="text-center">
            <p className="text-sm mb-3 text-[#725d42]">
              双方都点击"准备好了"后开始同步播放
            </p>
            <div className="flex items-center justify-center gap-4">
              <Button type="primary" size="large" onClick={handleReady}>
                <Play size={18} className="mr-1 inline" />
                准备好了
              </Button>
              <span className={`text-xs ${peerReady ? 'text-green-600' : 'opacity-40'}`}>
                {peerReady ? 'TA 已就绪 ✓' : '等待对方…'}
              </span>
            </div>
          </Card>
        )}

        {phase === 'syncing' && (
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2 text-xs">
              {status === 'connected' ? (
                <Wifi size={14} className="text-green-500" />
              ) : (
                <WifiOff size={14} className="text-yellow-500" />
              )}
              <span className="opacity-60">
                {syncStatus === 'synced' && '已同步'}
                {syncStatus === 'drifting' && '校正中…'}
                {syncStatus === 'buffering' && '缓冲中…'}
              </span>
            </div>
            <span className="text-xs opacity-40">房间 {code}</span>
          </div>
        )}
      </div>
    </div>
  );
}
