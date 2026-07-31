import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Button, Card, Notification } from 'animal-island-ui';
import { useWebSocket, useWsMessage } from '../../hooks/useWebSocket';
import { getSharedFile } from '../../services/room/fileStore';
import { LocalFileAdapter } from '../../services/playback/LocalFileAdapter';
import { WebrtcStreamAdapter } from '../../services/playback/WebrtcStreamAdapter';
import { ClockSync } from '../../services/sync/ClockSync';
import { SyncEngine, type SyncEngineEvent } from '../../services/sync/SyncEngine';
import { screenShareStore } from '../../services/webrtc/screenShareStore';
import { fileTransferStore } from '../../services/webrtc/fileTransferStore';
import { debugStore } from '../../services/debugStore';
import { ConnectionStats } from '../common/ConnectionStats';
import { Play, Wifi, WifiOff, Gauge, Monitor, Maximize, Download } from 'lucide-react';

type Phase = 'loading' | 'ready-prompt' | 'syncing' | 'missing-file' | 'viewing';
type SyncStatus = 'synced' | 'drifting' | 'buffering';

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export function PlayerPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navState = (location.state as { mode?: string } | null) ?? null;
  const isScreenShare = navState?.mode === 'screen-share';
  const isFileComplete = navState?.mode === 'file-complete';
  const { status, send, userId } = useWebSocket();

  const [phase, setPhase] = useState<Phase>('loading');
  const [peerReady, setPeerReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('synced');
  const [bufferingTimeout, setBufferingTimeout] = useState(false);
  const [peerDisconnected, setPeerDisconnected] = useState(false);
  const [currentRate, setCurrentRate] = useState<number>(1);
  const [bufferMs, setBufferMs] = useState(0);  // 屏幕分享观看缓冲（jitterBufferTarget，毫秒）

  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<LocalFileAdapter | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const clockRef = useRef(new ClockSync());
  const syncStartedRef = useRef(false);
  const selfReadyRef = useRef(false);

  // 初始化播放器
  useEffect(() => {
    // 屏幕分享模式：使用远端流
    if (isScreenShare) {
      const stream = screenShareStore.getActiveStream();
      if (!stream || !containerRef.current) {
        setPhase('missing-file');
        return;
      }
      const adapter = new WebrtcStreamAdapter(containerRef.current);
      adapterRef.current = adapter as unknown as LocalFileAdapter;
      adapter.load({ kind: 'webrtc-stream', stream }).then(() => {
        adapter.play().catch(() => {});
        setPhase('viewing');
      }).catch(() => {
        Notification.error({ message: '流加载失败' });
        navigate(`/room/${code}`);
      });
      return () => { adapter.destroy(); screenShareStore.reset(); };
    }

    const file = getSharedFile();
    const isFileStream = navState?.mode === 'file-stream';

    // 流式接收方：无本地 File，用 MSE controller 的 objectUrl 播放（后台仍在持续接收）
    if (isFileStream && !file) {
      const controller = fileTransferStore.getController();
      if (!controller || !containerRef.current) {
        setPhase('missing-file');
        return;
      }
      const adapter = new LocalFileAdapter(containerRef.current);
      adapterRef.current = adapter;
      adapter.on('ratechange', () => setCurrentRate(adapter.getRate()));
      adapter.on('error', (d) => {
        debugStore.logError('player', 'video-error(stream)', JSON.stringify(d ?? {}));
        Notification.error({ message: '流式播放失败', description: '该视频编码可能不支持流式，请改用完整传输' });
      });
      adapter.load({ kind: 'object-url', url: controller.objectUrl }).then(() => {
        setPhase('ready-prompt');
      }).catch(() => {
        Notification.error({ message: '流加载失败', description: '请返回房间重试' });
        navigate(`/room/${code}`);
      });
      return () => {
        engineRef.current?.stop();
        adapter.destroy();
        fileTransferStore.reset();
      };
    }

    // Fix: 无文件时不立即 navigate（避免与 session:restored 竞态），
    // 改为展示友好提示，用户可手动返回
    if (!file || !containerRef.current) {
      setPhase('missing-file');
      return;
    }

    const adapter = new LocalFileAdapter(containerRef.current);
    adapterRef.current = adapter;

    // 监听倍速变化同步 UI 状态（包括远端触发的倍速）
    adapter.on('ratechange', () => {
      setCurrentRate(adapter.getRate());
    });
    adapter.on('error', (d) => {
      debugStore.logError('player', 'video-error', JSON.stringify(d ?? {}));
    });

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

  // 启动同步引擎（useCallback 包裹，解决 useEffect 依赖问题）
  const startSync = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter || !userId) return;
    if (syncStartedRef.current) return;
    syncStartedRef.current = true;

    const engine = new SyncEngine({
      adapter,
      transport: { send: (msg: Record<string, unknown>) => send(msg) },
      clockSync: clockRef.current,
      userId,
      onEvent: (evt: SyncEngineEvent) => {
        debugStore.log('sync', 'engine-event', evt);
        switch (evt) {
          case 'buffering':
            setSyncStatus('buffering');
            break;
          case 'drifting':
            setSyncStatus('drifting');
            break;
          case 'synced':
            setSyncStatus('synced');
            break;
          case 'buffering-timeout':
            setBufferingTimeout(true);
            Notification.warning({
              message: '对方网络较差',
              description: '对方缓冲超过 30 秒，你可以选择继续独立观看',
            });
            break;
        }
      },
    });
    engineRef.current = engine;
    engine.start();

    // 请求对方全量状态追齐
    engine.requestState();
    setPhase('syncing');
  }, [userId, send]);

  // 对方 ready 后如果自己也 ready → 启动同步（Fix Bug 5: startSync 在依赖中）
  useEffect(() => {
    if (peerReady && phase === 'syncing' && !engineRef.current) {
      startSync();
    }
  }, [peerReady, phase, startSync]);

  // 处理远端消息（刻意不用 useCallback：useWsMessage 每次渲染更新 handlerRef，
  // 普通函数保证闭包永远读到最新 state，避免 stale closure）
  const handleMessage = (msg: Record<string, unknown>) => {
    // 迟到的 WebRTC 信令：观看方的 stream 事件早于 ICE 完成就跳转到本页，
    // 后续 candidate 必须继续喂给 peer，否则连接可能永远建立不起来（黑屏）
    if (msg.type === 'rtc:signal') {
      // 屏幕分享 / 文件流式传输共用信令转发（哪个 peer 存在就喂给谁）
      const peer = (screenShareStore.state.peer ?? fileTransferStore.getPeer()) as { signal: (d: unknown) => void; destroyed?: boolean } | null;
      if (peer && !peer.destroyed) {
        peer.signal(msg.data);
      } else {
        debugStore.log('rtc', 'signal-dropped-no-peer', (msg.data as { type?: string })?.type ?? 'candidate');
      }
      return;
    }

    // sync:* 消息全部交给引擎处理（心跳双向握手已在引擎内部完成）
    if ((msg.type as string).startsWith('sync:')) {
      if (!engineRef.current) {
        // 引擎未启动时 sync 消息被丢弃——记入诊断日志（握手死锁的关键线索）
        debugStore.log('sync', 'msg-dropped-no-engine', msg.type);
      }
      engineRef.current?.handleRemoteMessage(msg);
      // 从消息中直接提取倍速同步 UI（避免依赖异步 ratechange 事件链）
      const data = msg.data as { rate?: number } | undefined;
      if (typeof data?.rate === 'number') {
        setCurrentRate(data.rate);
      }
      return;
    }

    // 对方点击"准备好了"
    if (msg.type === 'player:ready') {
      setPeerReady(true);
      // Fix：幂等回执。若自己已就绪则回发一条（echo 标记防止无限往返），
      // 解决"先进播放页一方的 ready 在对方挂载前发出而丢失"的握手死锁
      const isEcho = (msg.data as { echo?: boolean } | undefined)?.echo === true;
      if (selfReadyRef.current && !isEcho) {
        send({ type: 'player:ready', data: { echo: true } });
      }
    }

    // screen:stop → 对方停止分享
    if (msg.type === 'screen:stop') {
      if (isScreenShare) {
        Notification.info({ message: '分享已结束', description: '对方停止了屏幕分享' });
        screenShareStore.reset();
        navigate(`/room/${code}`);
      }
      return;
    }

    // Bug C: 对方离开 → 自动暂停视频，保留"继续播放"选项
    if (msg.type === 'room:left') {
      adapterRef.current?.pause();
      engineRef.current?.stop();
      engineRef.current = null;
      syncStartedRef.current = false;
      setPeerReady(false);
      setPeerDisconnected(true);
    }

    // 对方重连加入 → 退回到 ready-prompt 让双方重新握手
    if (msg.type === 'room:peer-joined') {
      adapterRef.current?.pause();
      // 停止旧引擎
      if (engineRef.current) {
        engineRef.current.stop();
        engineRef.current = null;
        syncStartedRef.current = false;
      }
      setPeerDisconnected(false);
      // 退回到准备阶段，双方重新点击"准备好了"
      setPhase('ready-prompt');
      setPeerReady(false);
      selfReadyRef.current = false;
    }

    // 房间被销毁 → 提示并返回房间页
    if (msg.type === 'error' && (msg.data as { code?: string })?.code === 'ROOM_NOT_FOUND') {
      Notification.error({ message: '房间已关闭', description: '正在返回等待室…' });
      engineRef.current?.stop();
      engineRef.current = null;
      syncStartedRef.current = false;
      navigate(`/room/${code}`);
    }
  };

  useWsMessage(handleMessage);

  // 全屏切换（屏幕分享观看）
  const handleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {
        Notification.warning({ message: '全屏失败', description: '当前浏览器不支持全屏 API' });
      });
    }
  };

  // 保存收到的完整文件到本地（完整传输接收方）
  const handleSave = () => {
    const file = getSharedFile();
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  // 倍速切换（SyncEngine 监听 ratechange 自动广播）
  const handleRateChange = (rate: number) => {
    adapterRef.current?.setRate(rate);
    setCurrentRate(rate);
  };

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
    selfReadyRef.current = true;
    send({ type: 'player:ready', data: {} });

    // 如果对方也已就绪 → 启动同步引擎
    if (peerReady) {
      startSync();
    } else {
      setPhase('syncing'); // 先显示播放器，等对方 ready 后自动开始
    }
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

      {/* 完整传输接收方：保存到本地 */}
      {isFileComplete && (
        <div className="w-full max-w-3xl mt-2 flex justify-end">
          <Button size="small" type="default" onClick={handleSave}>
            <Download size={14} className="mr-1 inline" />
            保存到本地
          </Button>
        </div>
      )}

      {/* 准备/同步控制区 */}
      <div className="w-full max-w-3xl mt-4">
        {phase === 'missing-file' && (
          <Card color="app-yellow" className="text-center">
            <p className="text-sm text-[#725d42] mb-1">
              {isScreenShare ? '屏幕分享流已断开' : '视频文件已失效'}
            </p>
            <p className="text-xs opacity-60 mb-4">
              {isScreenShare
                ? '对方已停止分享或连接中断'
                : '刷新页面后需要重新选择文件，请返回房间重新操作'}
            </p>
            <Button type="primary" size="large" onClick={() => navigate(`/room/${code}`)}>
              返回房间
            </Button>
          </Card>
        )}

        {phase === 'viewing' && (
          <Card color="app-green" className="text-center">
            <div className="flex items-center justify-center gap-2 text-sm text-[#725d42] mb-2">
              <Monitor size={16} />
              {status === 'connected' ? (
                <Wifi size={14} className="text-green-500" />
              ) : (
                <WifiOff size={14} className="text-yellow-500" />
              )}
              正在观看
              <button
                onClick={handleFullscreen}
                title="全屏"
                className="ml-2 p-1 rounded hover:bg-black/10 transition-colors"
              >
                <Maximize size={16} />
              </button>
            </div>
            <ConnectionStats />
            <div className="flex items-center gap-1 justify-center flex-wrap mt-2">
              <span className="text-[10px] opacity-40">缓冲</span>
              {([['最低延迟', 0], ['流畅≈1s', 1000], ['更稳≈2s', 2000]] as [string, number][]).map(([label, ms]) => (
                <button
                  key={ms}
                  onClick={() => { setBufferMs(ms); screenShareStore.setJitterBufferTarget(ms); }}
                  className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                    bufferMs === ms ? 'bg-[#19c8b9] text-white border-[#19c8b9]' : 'border-gray-200 text-gray-500 hover:border-[#19c8b9]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Card>
        )}

        {!isScreenShare && phase === 'ready-prompt' && (
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
          <div className="space-y-2">
            {/* 对方断线提示栏（Bug C） */}
            {peerDisconnected && (
              <Card color="app-yellow" className="text-center">
                <p className="text-sm text-[#725d42] mb-1">
                  对方已断开连接
                </p>
                <p className="text-xs opacity-60 mb-3">
                  视频已自动暂停，等待对方重连或选择继续独立观看
                </p>
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    setPeerDisconnected(false);
                    adapterRef.current?.play().catch(() => {});
                  }}
                >
                  继续播放
                </Button>
              </Card>
            )}

            {/* 倍速选择器 */}
            <div className="flex items-center justify-center gap-1">
              <Gauge size={12} className="opacity-40" />
              {SPEED_OPTIONS.map(rate => (
                <button
                  key={rate}
                  onClick={() => handleRateChange(rate)}
                  className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                    currentRate === rate
                      ? 'bg-[#19c8b9] text-white border-[#19c8b9]'
                      : 'border-gray-200 text-gray-500 hover:border-[#19c8b9] hover:text-[#19c8b9]'
                  }`}
                >
                  {rate}x
                </button>
              ))}
            </div>

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
                  {syncStatus === 'buffering' && '对方缓冲中·已暂停'}
                </span>
              </div>
              <span className="text-xs opacity-40">房间 {code}</span>
            </div>
            {bufferingTimeout && (
              <div className="flex items-center justify-between bg-[#fffbeb] border border-[#f59e0b] rounded-lg p-3">
                <p className="text-xs text-[#92400e]">
                  对方网络持续较差，已等待 30 秒。你可以选择继续独立观看。
                </p>
                <Button size="small" type="default" onClick={() => {
                  engineRef.current?.stop();
                  setBufferingTimeout(false);
                }}>
                  独立观看
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
