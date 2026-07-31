# PLAN2 — 迁移到 simple-peer

## 背景

当前 WebRTC 手搓方案（`PeerConnectionManager` 344 行 + `ScreenShare` 159 行）虽已定位到时序竞态 bug，但 simple-peer 作为久经考验的 WebRTC 封装库，内部状态机自动处理 offer/answer/ICE 时序，可根本性消除此类问题。

**simple-peer 仍是纯 P2P，不改变现有架构。** 它只是一个更可靠的 RTCPeerConnection 包装器。

### 迁移前后对比

```
迁移前:  迁移后:
PCM.ts (344 行)  →  simple-peer Peer（无代码）
ScreenShare.ts (158 行) →  ScreenShare.ts (~60 行)
协议: rtc:offer/answer/ice  →  rtc:signal（单一消息）
ICE 缓冲机制 (RoomPage)  →  删除（simple-peer 内部处理）
```

---

## Step 1: 安装依赖

```bash
cd client
npm install simple-peer
npm install -D vite-plugin-node-polyfills
```

> 注意：simple-peer 使用 Node.js 语义（Buffer、stream、events），Vite 无法原生处理。`vite-plugin-node-polyfills` 自动提供浏览器 polyfill。

---

## Step 2: Vite 配置 (client/vite.config.ts)

新增 `vite-plugin-node-polyfills` 插件和 global 定义：

```diff
 import { defineConfig } from 'vite'
 import react from '@vitejs/plugin-react'
 import tailwindcss from '@tailwindcss/vite'
+import { nodePolyfills } from 'vite-plugin-node-polyfills'

 export default defineConfig({
-  plugins: [react(), tailwindcss()],
+  plugins: [
+    react(),
+    tailwindcss(),
+    nodePolyfills({ include: ['buffer', 'stream', 'events', 'process'] }),
+  ],
   server: {
     port: 3000,
     proxy: { /* 不变 */ },
   },
+  define: {
+    global: 'globalThis',
+  },
 })
```

---

## Step 3: 精简服务端协议 (server/src/ws/protocol.ts)

### 删除
- `RtcOfferMsg`
- `RtcAnswerMsg`
- `RtcIceMsg`

### 新增
```typescript
// Stage 2: WebRTC 信令 (simple-peer 统一信令)
export interface RtcSignalMsg extends WsMessage {
  type: 'rtc:signal';
  data: unknown;  // simple-peer signal data (JSON-serializable)
}
```

### 服务端适配 (server/src/app.ts)

- `'rtc:offer', 'rtc:answer', 'rtc:ice'` → `'rtc:signal'`
- `FORWARD_WHITELIST` 和 `NO_ROOM_TYPES` 同步更新
- `rtc:` 消息量豁免保持（`startsWith('rtc:')` 逻辑不变）

---

## Step 4: 重写 ScreenShare.ts

```typescript
import Peer from 'simple-peer';
import { screenShareStore } from './screenShareStore';
import { debugStore } from '../debugStore';
import { PCStatsCollector } from './PCStatsCollector';

export type ScreenShareState = 'idle' | 'requesting' | 'running' | 'error';

export class ScreenShareService {
  private peer: Peer.Instance | null = null;
  private collector: PCStatsCollector | null = null;
  private localStream: MediaStream | null = null;
  private onStateChange?: (s: ScreenShareState) => void;

  async startSharing(sendSignal: (data: unknown) => void): Promise<MediaStream> {
    this.notifyState('requesting');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    this.localStream = stream;

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.notifyState('idle');
    });

    this.peer = new Peer({ initiator: true, stream, config: await this.getRtcConfig() });

    this.peer.on('signal', data => sendSignal(data));
    this.peer.on('error', err => console.error('[SS-A] peer error:', err));
    this.peer.on('connect', () => {
      // DataChannel 已就绪（如果有）
    });

    this.collector = new PCStatsCollector(this.peer);
    this.collector.start(snapshot => debugStore.setRtcStats(snapshot));

    screenShareStore.setSharing(stream, this.peer, this.collector);
    this.notifyState('running');
    return stream;
  }

  async startViewing(
    sendSignal: (data: unknown) => void,
    existingSignal?: unknown
  ): Promise<MediaStream> {
    this.notifyState('requesting');

    this.peer = new Peer({ initiator: false, config: await this.getRtcConfig() });
    this.peer.on('signal', data => sendSignal(data));

    screenShareStore.setPendingPCM(this.peer);

    if (existingSignal) {
      this.peer.signal(existingSignal);
    }

    const stream = await new Promise<MediaStream>((resolve, reject) => {
      this.peer!.on('stream', resolve);
      this.peer!.on('error', reject);
      // 10s 超时
      setTimeout(() => reject(new Error('TRACK_TIMEOUT')), 10000);
    });

    // ★ 流程到这里时，ICE 已经在 simple-peer 内部自动完成了

    this.collector = new PCStatsCollector(this.peer);
    this.collector.start(snapshot => debugStore.setRtcStats(snapshot));

    screenShareStore.setViewing(stream, this.peer, this.collector);
    this.notifyState('running');
    return stream;
  }

  stop(): void { /* 不变 */ }
  getConnectionState(): RTCPeerConnectionState { /* 不变 */ }

  private async getRtcConfig(): Promise<RTCConfiguration> {
    try {
      const resp = await fetch('/api/ice-servers');
      const data = await resp.json();
      return { iceServers: data.iceServers ?? [], iceTransportPolicy: 'all' };
    } catch {
      return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    }
  }

  private notifyState(s: ScreenShareState) { this.onStateChange?.(s); }
  onStateChangeHandler(cb: (s: ScreenShareState) => void) { this.onStateChange = cb; }
}
```

**关键变化**：
- 不再需要 `SignalingAdapter` 接口 —— 直接收一个 `sendSignal(data)` 回调
- `startSharing`: `getDisplayMedia` → `new Peer({initiator:true})` → 完成
- `startViewing`: `new Peer({initiator:false})` → `peer.signal(existingSignal)` → `await peer.on('stream')`
- **无需 ICE 缓冲**：`peer.signal()` 同时处理 offer 和后续 ICE 候选

---

## Step 5: 更新 screenShareStore.ts

```diff
- import { PeerConnectionManager } from './PeerConnectionManager';
+ import Peer from 'simple-peer';

  interface ScreenShareState {
    stream: MediaStream | null;
-   pcm: PeerConnectionManager | null;
+   peer: Peer.Instance | null;
    collector: PCStatsCollector | null;
  }

  const state = reactive<ScreenShareState>({
    stream: null,
-   pcm: null,
+   peer: null,
    collector: null,
  });

- export function setSharing(stream, pcm, collector): void { ... }
+ export function setSharing(stream, peer, collector): void { ... }

- export function setPendingPCM(pcm): void { state.pcm = pcm; }
+ export function setPendingPCM(peer): void { state.peer = peer; }
```

> 注：保持方法名 `setPendingPCM` 兼容现有 RoomPage 调用，后续可重命名。

---

## Step 6: 更新 PCStatsCollector.ts

```diff
  export class PCStatsCollector {
-   private pcm: PeerConnectionManager;
+   private peer: Peer.Instance;

-   constructor(pcm: PeerConnectionManager) {
-     this.pcm = pcm;
-     this.pcm.setTimelineHandler((event) => { ... });
+   constructor(peer: Peer.Instance) {
+     this.peer = peer;
    }

    async poll(): Promise<void> {
-     const pc = this.pcm.getPeerConnection();
+     const pc = (this.peer as any)._pc as RTCPeerConnection;
+     if (!pc) return;
      const stats = await pc.getStats();
      // ... 其余逻辑不变
    }
  }
```

> `peer._pc` 是 simple-peer 暴露底层 RTCPeerConnection 的非公开属性（但广泛使用），getStats 采集逻辑完全保留。

---

## Step 7: 更新 RoomPage.tsx

### 7.1 删除 SignalingAdapter

当前 `buildSignalingAdapter()` (~30 行) 整个删除。simple-peer 不需要适配器。

### 7.2 简化 handleShare

```typescript
const handleShare = async () => {
  const svc = new ScreenShareService();
  screenRef.current = svc;
  svc.onStateChangeHandler(setScreenShareState);
  try {
    await svc.startSharing((data) => send({ type: 'rtc:signal', data }));
    navigate(`/room/${code}/play`, { state: { mode: 'screen-share' } });
  } catch (err) {
    Notification.error({ message: '分享失败', description: '请检查浏览器权限设置' });
    setScreenShareState('idle');
    send({ type: 'screen:stop', data: {} });
  }
};
```

### 7.3 简化 handleIncomingShare

```typescript
const handleIncomingShare = async (signalData: unknown) => {
  const svc = new ScreenShareService();
  screenRef.current = svc;
  svc.onStateChangeHandler(setScreenShareState);
  try {
    await svc.startViewing(
      (data) => send({ type: 'rtc:signal', data }),
      signalData  // 把已收到的 offer 传进去
    );
    navigate(`/room/${code}/play`, { state: { mode: 'screen-share' } });
  } catch (err) {
    console.error('[SS-B] startViewing 失败:', err);
    Notification.error({ message: '连接失败', description: '无法建立 P2P 连接' });
    setScreenShareState('idle');
  }
};
```

### 7.4 删除 ICE 缓冲机制

**删除** `iceBufferRef`、ICE 缓冲监听、flush ICE buffer 逻辑——simple-peer 内部通过 `peer.signal()` 自动管理 ICE 时序。

### 7.5 更新消息处理

```diff
- case 'rtc:offer':
-   if (key !== code) break;
-   handleIncomingShare(data.sdp);
-   break;

- case 'rtc:answer':
- case 'rtc:ice':
-   // 通过 store.pcm 处理
-   break;

+ case 'rtc:signal':
+   if (key !== code) break;
+   const peer = screenShareStore.state.peer;
+   if (peer) {
+     (peer as any).signal(data);
+   } else {
+     // signal 先于 handleIncomingShare 到达 → handleIncomingShare 会自己处理
+     handleIncomingShare(data);
+   }
+   break;
```

> 此逻辑可以进一步简化：将 `screen:grant` 收到的 offer signal 缓存，`handleIncomingShare` 时直接用。

---

## Step 8: 更新 PlayerPage.tsx

`WebrtcStreamAdapter` 逻辑不变。只需确认 `screenShareStore.state.stream` 仍是 `MediaStream` 类型（simple-peer 通过 `'stream'` 事件提供的就是 MediaStream）。

---

## Step 9: 删除旧文件

```bash
rm client/src/services/webrtc/PeerConnectionManager.ts
```

这是被 simple-peer 完全替代的文件。

---

## Step 10: 更新 types.ts

可选精简：删除不再需要的类型（如 `CandidateInfo`、`SelectedPair`），仅保留 `PCStatsSnapshot`、`TimelineEvent` 等仍使用户 DebugPanel 的类型。

---

## 迁移影响总结

| 操作 | 文件 | 代码量变化 |
|------|------|-----------|
| 安装 | `package.json` | +2 deps |
| 新增 | `vite.config.ts` | +5 行 |
| 删除 | `PeerConnectionManager.ts` | -344 行 |
| 重写 | `ScreenShare.ts` | 159→~60 行 |
| 更新 | `screenShareStore.ts` | ~10 行改名 |
| 更新 | `PCStatsCollector.ts` | ~5 行适配 |
| 简化 | `RoomPage.tsx` | -60 行（删除 ICE 缓冲 + SignalingAdapter） |
| 简化 | `server/src/ws/protocol.ts` | -20 行（3 消息合并为 1） |
| 简化 | `server/src/app.ts` | -5 行 |
| 删除 | `types.ts` 部分类型 | 可选 |
| **合计** | | **净减 ~350 行** |

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| simple-peer 依赖 Node.js polyfills 增加打包体积 | `vite-plugin-node-polyfills` 按需引入，增量 < 50KB |
| `peer._pc` 非公开 API，未来版本可能变化 | simple-peer 多年未改此属性；备选方案：存储底层 PC 引用 |
| 失去对 DataChannel 的精细控制 | simple-peer 内置 DataChannel：`peer.send()` / `peer.on('data')` 足够当前需求 |
