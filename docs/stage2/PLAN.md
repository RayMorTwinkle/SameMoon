# Stage 2 计划：WebRTC P2P 文件传输 + 屏幕分享

## 一、目标

在现有「双方本地文件同步播放」基础上，新增两种协作模式：

1. **文件传输模式**：房主选文件 → P2P 传输给 guest → 双方同步播放（guest 无需本地有该文件）
2. **屏幕分享模式**：一方分享屏幕 → 对方实时观看（纯跟随，无播放控制）

两种模式都基于 **WebRTC**，共享连接基础设施。

---

## 二、关键决策

| 决策项 | 选定方案 | 理由 |
|--------|---------|------|
| NAT 穿透 | Cloudflare TURN（STUN+TURN） | 免自建、全球分布、免费额度 |
| 模式入口 | **房主创建房间时决定** | 简化 guest 侧流程，模式即房间属性 |
| 文件传输方向 | **仅 host → guest** | 房主拥有房间，语义清晰 |
| 屏幕分享方向 | **双向（一次一个）** | 灵活，但同一时刻只允许一方分享 |
| 屏幕分享控制 | **纯跟随** | 观看方无播放控制，仅观看 |
| 不支持 MSE 的格式 | **传完再播** | MKV 等格式不支持流式，降级处理 |
| 信令通道 | 复用现有 WS | `rtc:offer/answer/ice` 已在白名单 |

---

## 三、模式系统

### 3.1 三种模式

| 模式 | 标识 | 说明 |
|------|------|------|
| 本地同步 | `local-sync` | 现有模式，双方各自选本地文件匹配后同步 |
| 文件传输 | `file-transfer` | 房主选文件，P2P 传给 guest，传完双方同步播放 |
| 屏幕分享 | `screen-share` | 一方分享屏幕，对方实时观看 |

### 3.2 模式生命周期

```
Host 创建房间时选择 mode
  → 房间携带 mode 属性
  → Guest 加入时收到 mode → UI 自适应
  → 模式在房间生命周期内不可切换（避免状态混乱）
  → 房间销毁后重新创建可选新模式
```

### 3.3 RoomPage 按模式的 UI 分支

| 模式 | Host UI | Guest UI |
|------|---------|----------|
| `local-sync` | 现有：选文件 + 匹配 | 现有：选文件 + 匹配 |
| `file-transfer` | 选文件 + 发送按钮 + 传输进度 | 等待 + 接收进度 + 传完自动进入播放 |
| `screen-share` | 「分享我的屏幕」按钮 + 预览 | 「等待对方分享」/ 观看画面 |

---

## 四、WebRTC 基础设施（共享）

### 4.1 Cloudflare TURN 凭据服务

服务端新增端点，代理调用 Cloudflare API 生成短期凭据：

```
GET /api/ice-servers
  → 服务端检查缓存（TTL < 24h）
  → 过期则调用 Cloudflare API：
    POST https://rtc.live.cloudflare.com/v1/turn/keys/{KEY_ID}/credentials/generate-ice-servers
    Authorization: Bearer {API_TOKEN}
    Body: { "ttl": 86400 }
  → 返回 { iceServers: [...] }
```

**环境变量**（写入 `.env`，不入库）：
```
TURN_KEY_ID=73ea334142af06b9d8f835e31d0fc1f4
TURN_API_TOKEN=3674f6a26801b3b524aba83575662ce9673dc8a8f07b3267635021bd3c95e2df
```

**凭据缓存**：服务端内存缓存，TTL 设为 23 小时（比 Cloudflare 的 24h 早 1h 刷新），避免每次请求都打 Cloudflare API。

### 4.2 信令流程

复用现有 WS 连接，`rtc:offer/answer/ice` 已在服务端转发白名单。新增协调消息（见 §七）。

```
A 创建 RTCPeerConnection
  → createOffer → rtc:offer (via WS)
  → B 收到 → createAnswer → rtc:answer (via WS)
  → 双方交换 ICE candidates → rtc:ice (via WS)
  → 连接建立 (ICE connected)
```

### 4.3 PeerConnectionManager 服务

封装 RTCPeerConnection 生命周期，两个功能共用：

```ts
class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private iceServers: RTCIceServer[];

  async initialize(): Promise<void>;           // 获取 iceServers + 创建 PC
  createDataChannel(label: string): RTCDataChannel;
  addTrack(track: MediaStreamTrack): RTCRtpSender;
  onTrack(cb: (stream: MediaStream) => void): void;
  async createOffer(): Promise<RTCSessionDescriptionInit>;
  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  onConnectionStateChange(cb: (state: RTCPeerConnectionState) => void): void;
  close(): void;
}
```

---

## 五、功能一：文件传输（host → guest）

### 5.1 流程

```
Host 选文件 → 元数据发送（name/size/type via WS）
  → 建立 WebRTC DataChannel "file-transfer"
  → 信令交换 (rtc:offer/answer/ice)
  → DataChannel open:
      Host: 分块读取文件 → 逐块发送 → 流控（bufferedAmount）
      Guest: 逐块接收 → 累积到 chunks[] → 更新进度条
  → 传输完成:
      Guest: chunks → Blob → File → 走现有 local-file 路径
      双方进入 PlayerPage → SyncEngine 同步播放（零改动）
```

### 5.2 分块与流控

| 参数 | 值 | 说明 |
|------|-----|------|
| 分块大小 | 64 KB | 所有浏览器安全支持 |
| 高水位 | 1 MB | `bufferedAmount > 1MB` 时暂停发送 |
| 低水位 | 256 KB | `bufferedAmount < 256KB` 时恢复发送 |
| 消息类型 | ArrayBuffer | 二进制高效传输 |

### 5.3 进度与状态同步

通过 WS 发送轻量状态消息（非 DataChannel，确保对方 UI 可靠更新）：

```
file:progress  { transferred, total, speed }   // Host → Guest via WS
file:complete  { }                               // Host → Guest via WS
file:cancelled { reason }                        // 任一方可取消
```

### 5.4 MSE 流式播放（阶段 B，可选）

仅对 MP4（faststart）/ WebM / fragmented MP4 生效：

```
Guest 收到前几块 → 检测容器格式
  → 支持 MSE: 创建 MediaSource → SourceBuffer 喂块 → ArtPlayer 播放
  → 不支持: 走完整下载降级
```

**阶段 A 先做完整下载**，MSE 留作后续优化。

---

## 六、功能二：屏幕分享（双向，一次一个）

### 6.1 流程

```
A 点击「分享我的屏幕」
  → screen:request (via WS) → 服务端检查是否有人正在分享
  → screen:grant → A 调用 getDisplayMedia({ video: true, audio: true })
  → 创建 RTCPeerConnection → addTrack(screenStream)
  → rtc:offer → B 收到 → rtc:answer → 连接建立
  → B 的 onTrack → MediaStream → <video> 播放

A 停止分享（浏览器 UI 或按钮）:
  → screen:stop (via WS) → B 收到 → 清理 video
  → 释放 RTCPeerConnection
  → 恢复「分享我的屏幕」按钮可用
```

### 6.2 一次一个的协调

服务端维护 `room.screenSharer: string | null`：

- `screen:request` → 若 `screenSharer !== null` → 回复 `screen:busy`
- `screen:request` → 若空闲 → 设 `screenSharer = requester` → 回复 `screen:grant`
- `screen:stop` → 清空 `screenSharer`

### 6.3 观看方 UI

纯跟随，无播放控制：
- 全屏视频画面
- 「对方正在分享屏幕」状态提示
- 分享方停止时显示「分享已结束」

### 6.4 分享方预览

分享方自己的屏幕也显示在画面中（本地预览），可看到对方视角。

---

## 七、协议新增消息

### 7.1 房间模式

```ts
// room:create 新增 mode 字段
{ type: 'room:create', data: { mode: 'file-transfer' } }

// room:created / room:joined 携带 mode
{ type: 'room:created', data: { roomCode, role, mode } }
{ type: 'room:joined', data: { userId, role, peerCount, mode } }
```

### 7.2 文件传输

| type | 方向 | data | 说明 |
|------|------|------|------|
| `file:offer` | Host→Guest | `{ name, size, type }` | 传输前元数据通知 |
| `file:accept` | Guest→Host | `{}` | Guest 同意接收 |
| `file:progress` | Host→Guest | `{ transferred, total }` | 进度更新 |
| `file:complete` | Host→Guest | `{}` | 传输完成 |
| `file:cancelled` | 双向 | `{ reason? }` | 取消传输 |

### 7.3 屏幕分享协调

| type | 方向 | data | 说明 |
|------|------|------|------|
| `screen:request` | C→S | `{}` | 请求分享权限 |
| `screen:grant` | S→C | `{}` | 授权分享 |
| `screen:busy` | S→C | `{ sharer: userId }` | 已有人分享，拒绝 |
| `screen:stop` | C→S / S→C | `{}` | 停止分享 |

### 7.4 WebRTC 信令（已在白名单）

| type | 方向 | 说明 |
|------|------|------|
| `rtc:offer` | C→S→C | SDP offer |
| `rtc:answer` | C→S→C | SDP answer |
| `rtc:ice` | C→S→C | ICE candidate |

---

## 八、文件结构

### 8.1 新增文件

```
client/src/
├── services/
│   ├── webrtc/
│   │   ├── PeerConnectionManager.ts    # RTCPeerConnection 封装
│   │   ├── FileTransfer.ts             # DataChannel 分块发送/接收
│   │   ├── ScreenShare.ts              # getDisplayMedia + track 管理
│   │   └── types.ts                    # WebRTC 相关类型
│   └── playback/
│       └── WebrtcStreamAdapter.ts      # 屏幕分享的 PlaybackAdapter 实现
├── components/
│   ├── Room/
│   │   ├── HomePage.tsx                # 修改：创建房间时选模式
│   │   ├── RoomPage.tsx                # 修改：按模式分支 UI
│   │   └── FileTransferPanel.tsx       # 新增：传输进度面板
│   └── Player/
│       └── PlayerPage.tsx              # 修改：支持屏幕分享流播放

server/src/
├── app.ts                              # 修改：/api/ice-servers + 模式 + screen 协调
├── room/RoomManager.ts                 # 修改：room.mode + screenSharer
└── ws/protocol.ts                      # 修改：新增消息类型
```

### 8.2 修改现有文件

| 文件 | 改动 |
|------|------|
| `client/src/components/Room/HomePage.tsx` | 创建房间表单加模式选择器 |
| `client/src/components/Room/RoomPage.tsx` | 按 `room.mode` 渲染不同 UI |
| `client/src/components/Player/PlayerPage.tsx` | 支持 `screen-share` 模式的流播放 |
| `server/src/app.ts` | 新增 `/api/ice-servers`、`screen:*` 处理、`file:*` 转发 |
| `server/src/room/RoomManager.ts` | Room 新增 `mode` 和 `screenSharer` 字段 |
| `server/src/ws/protocol.ts` | 新增消息类型定义 |

---

## 九、PlaybackAdapter 扩展

```ts
export type PlaybackSource =
  | { kind: 'local-file'; file: File }
  | { kind: 'direct-url'; url: string }
  | { kind: 'webrtc-stream'; stream: MediaStream }  // 新增
  | { kind: 'youtube'; videoId: string };
```

`WebrtcStreamAdapter` 实现要点：
- `load()` 直接将 `MediaStream` 赋给 `<video>.srcObject`
- `play()`/`pause()` 仍可用（本地暂停不影响远端流）
- `seek()`/`getTime()`/`getRate()` 对直播流无意义，返回固定值
- 屏幕分享模式下不启动 SyncEngine（纯跟随）

文件传输完成后，Guest 拿到完整 `File` → 走现有 `LocalFileAdapter` → SyncEngine 零改动同步。

---

## 十、实施步骤

### Step 1：WebRTC 基础设施 + 模式系统 + 部署

- [ ] 服务端：`.env` 管理 TURN 凭据
- [ ] 服务端：`/api/ice-servers` 端点 + Cloudflare TURN 集成 + 缓存
- [ ] 服务端：Room 新增 `mode` 字段，`room:create/created/joined` 携带 mode
- [ ] 服务端：转发白名单加 `file:*` 和 `screen:*` 消息
- [ ] 客户端：`PeerConnectionManager` 封装（含 `PCStatsCollector` 数据采集）
- [ ] 客户端：`PCStatsCollector` 实现（getStats 轮询 + 时间线记录）
- [ ] 客户端：DebugPanel 重构为 6 标签页 WebRTC 调试面板
- [ ] 客户端：HomePage 创建房间表单加模式选择器
- [ ] 客户端：RoomPage 按 mode 渲染分支 UI（先占位，后续 Step 填充）
- [ ] 部署：`Dockerfile` + `docker-compose.yml` + `deploy.sh`
- [ ] 首次部署到 150.158.149.24
- [ ] 测试：ice-servers 端点测试、模式传递测试、DebugPanel 数据展示

### Step 2：屏幕分享（验证 WebRTC 链路）

- [ ] 服务端：`screen:request/grant/busy/stop` 协调逻辑 + `room.screenSharer` 状态
- [ ] 客户端：`ScreenShare` 服务（`getDisplayMedia` + track 管理）
- [ ] 客户端：`WebrtcStreamAdapter` 实现
- [ ] 客户端：RoomPage `screen-share` 模式 UI（分享按钮 + 预览 + 观看）
- [ ] 客户端：PlayerPage 支持屏幕流播放
- [ ] 端到端测试：双窗口分享屏幕

### Step 3：文件传输（完整下载）

- [ ] 客户端：`FileTransfer` 服务（分块发送 + 流控 + 接收累积）
- [ ] 客户端：`FileTransferPanel` 进度 UI
- [ ] 客户端：RoomPage `file-transfer` 模式 UI（选文件 + 发送 + 接收）
- [ ] 客户端：传输完成后转 File → 进入 PlayerPage → SyncEngine 同步
- [ ] 服务端：`file:offer/accept/progress/complete/cancelled` 转发
- [ ] 端到端测试：双窗口传文件 + 同步播放

### Step 4：MSE 流式播放（可选优化）

- [ ] 格式检测：前几块判断容器格式
- [ ] `MediaSource` + `SourceBuffer` 集成
- [ ] ArtPlayer 播放 MediaSource 流
- [ ] 不支持格式降级到完整下载
- [ ] 测试：MP4/WebM 边传边播

---

## 十一、环境变量

服务端 `.env`（不入库）：

```bash
# Cloudflare TURN
TURN_KEY_ID=73ea334142af06b9d8f835e31d0fc1f4
TURN_API_TOKEN=3674f6a26801b3b524aba83575662ce9673dc8a8f07b3267635021bd3c95e2df
```

`.env.example` 占位：

```bash
TURN_KEY_ID=your_cloudflare_turn_key_id
TURN_API_TOKEN=your_cloudflare_turn_api_token
```

---

## 十二、测试策略

| 层级 | 内容 |
|------|------|
| 单元 | `PeerConnectionManager`（mock RTCPeerConnection）、`FileTransfer` 分块/流控逻辑 |
| 单元 | RoomManager 模式字段、screenSharer 协调 |
| 集成 | ice-servers 端点缓存、模式传递链路 |
| 端到端 | 双窗口屏幕分享、双窗口文件传输 + 同步播放 |
| 手测 | 不同网络环境（同 LAN / 跨网络 / 慢网）、TURN 中转验证 |

---

## 十三、风险与对策

| 风险 | 对策 |
|------|------|
| Cloudflare TURN 免费额度耗尽 | 监控用量，必要时自建 coturn |
| 大文件传输中断 | 阶段 A 不做断点续传，传输失败重来；阶段 B 可加 |
| 浏览器 getDisplayMedia 兼容性 | 主流浏览器支持，旧版 Safari 降级提示 |
| DataChannel 消息乱序 | 使用 `ordered: true`（默认）确保顺序 |
| 房间模式切换导致状态混乱 | 模式在房间生命周期内不可变 |

---

## 十四、WebRTC 调试面板（DebugPanel 扩展）

WebRTC 连接透明化是调试关键。DebugPanel 从现有 4 个字段扩展到 6 个信息区块，数据通过 `PCStatsCollector` 服务实时采集。

### 14.1 新增服务：`PCStatsCollector`

```ts
// client/src/services/webrtc/PCStatsCollector.ts
class PCStatsCollector {
  private pc: RTCPeerConnection;
  private interval: ReturnType<typeof setInterval> | null = null;
  private history: TimelineEvent[] = [];
  private onUpdate?: (snapshot: PCStatsSnapshot) => void;

  // 每 2s 拉取一次 getStats()
  start(onUpdate: (snapshot: PCStatsSnapshot) => void): void;
  stop(): void;

  // 记录连接状态变更时间线
  logTimeline(event: TimelineEvent): void;
}

interface PCStatsSnapshot {
  // ICE 连接状态
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;

  // 候选路由
  localCandidates: CandidateInfo[];     // 本地收集到的候选
  remoteCandidates: CandidateInfo[];   // 远端候选
  selectedPair: SelectedPair | null;   // 当前选中的候选对

  // 传输统计
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
  currentRoundTripTime: number;        // ms
  availableOutgoingBitrate: number;    // bps

  // DataChannel 状态
  dataChannels: DataChannelInfo[];

  // 时间线（最近 50 条）
  timeline: TimelineEvent[];
}

interface CandidateInfo {
  type: 'host' | 'srflx' | 'relay';   // 本地 / STUN / TURN
  protocol: 'udp' | 'tcp';
  address: string;
  port: number;
  priority: number;
}

interface SelectedPair {
  local: { type: string; address: string };
  remote: { type: string; address: string };
  nominated: boolean;
}

interface DataChannelInfo {
  label: string;
  state: RTCDataChannelState;
  bytesSent: number;
  bytesReceived: number;
  bufferedAmount: number;              // 待发送队列大小
}

interface TimelineEvent {
  ts: number;
  type: 'ice-state' | 'gathering' | 'pair-selected' | 'dc-open' | 'dc-close'
      | 'track-added' | 'track-removed' | 'signal' | 'error';
  detail: string;
}
```

### 14.2 DebugPanel UI 区块

现有 DebugPanel 重构为标签页布局，6 个区块：

```
┌──────────────────────────────┐
│ 🔍 调试面板            [✕]  │
├──────────────────────────────┤
│ [概况] [ICE路由] [传输] [通道]│  ← 标签页
│ [时间线] [消息日志]          │
├──────────────────────────────┤
│                              │
│  (Tab 内容，见下方)          │
│                              │
└──────────────────────────────┘
```

#### Tab 1：概况概览

| 指标 | 数据来源 | 说明 |
|------|---------|------|
| 房间模式 | WS | `local-sync` / `file-transfer` / `screen-share` |
| WS 状态 | useWebSocket | connected / reconnecting / disconnected |
| RTC 连接 | `iceConnectionState` | new / checking / connected / failed / disconnected |
| ICE 收集 | `iceGatheringState` | new / gathering / complete |
| RTT | `currentRoundTripTime` | 往返时延（ms） |
| 可用带宽 | `availableOutgoingBitrate` | 上行估算（bps） |
| 对方在线 | WS | 在线 / 离线 / 缓冲中 |
| 当前路由类型 | selectedPair | 🟢直连 / 🟡STUN / 🔴TURN 中转 |
| 用户体验总结 | 综合判断 | 一行文字：「✅ 连接正常，直连模式」「⚠️ 通过 TURN 中转，延迟可能较高」「❌ 连接失败」 |

#### Tab 2：ICE 路由详情

表格展示所有候选及配对状态：

```
本地候选 (8):
  type    地址              优先级      状态
  host    192.168.1.5:54782  2113932031   ✅ 选中 (与对方 host 配对)
  srflx   120.229.x.x:54782   842163199   备选
  relay   162.159.x.x:54782   41885439    备选

远端候选 (6):
  type    地址              优先级
  host    10.0.0.3:63291     2113932031   ← 当前配对
  srflx   183.12.x.x:63291    842163199

当前路由: host(本地) ↔ host(远端)  ← 🟢 直连，最优
```

用颜色标识：
- 🟢 **host** → 直连最快
- 🟡 **srflx** → STUN 打洞成功
- 🔴 **relay** → TURN 中转（有带宽成本）

高亮显示当前选中的候选对。

#### Tab 3：传输统计

| 指标 | 值 |
|------|-----|
| 发送字节 | 12.5 MB |
| 接收字节 | 8.3 MB |
| 发送包数 | 9,421 |
| 接收包数 | 6,237 |
| 丢包率 | 0.2% |
| 当前 RTT | 45 ms |
| 上行码率 | 3.2 Mbps |

#### Tab 4：DataChannel 通道

| 通道名 | 状态 | 发送 | 接收 | 待发送 |
|--------|------|------|------|--------|
| file-transfer | open | 12.5 MB | — | 256 KB |

标注 `open` / `closing` / `closed` 状态，待发送队列大小用于判断流控是否正常工作。

#### Tab 5：时间线

事件流倒序展示（最新在前），含时间戳和类型标签：

```
03:12:45  ✅ ICE connected               (ice-state)
03:12:43  🔗 选中 pair: host↔host         (pair-selected)
03:12:40  📡 收集到 srflx 候选            (gathering)
03:12:38  📡 收集到 host 候选             (gathering)
03:12:35  🔄 ICE checking                (ice-state)
03:12:30  📤 发送 rtc:offer              (signal)
03:12:30  🔌 DataChannel file-transfer open  (dc-open)
03:12:25  🔵 RTCPeerConnection 创建       (signal)
```

#### Tab 6：WS 消息日志

可筛选的消息列表：

```
时间      类型              方向    摘要
03:12:30  rtc:offer         发送    SDP (type: offer, 1523 chars)
03:12:31  rtc:ice           发送    candidate host 192.168...
03:12:32  rtc:answer        接收    SDP (type: answer, 1201 chars)
03:12:32  rtc:ice           接收    candidate host 10.0.0.3...
03:13:00  screen:grant      接收    {}
03:13:05  file:progress     发送    {transferred: 5242880, total: 104857600}
```

筛选按钮：`全部` `rtc:` `file:` `screen:` `sync:` `WS状态` `错误`

### 14.3 数据采集流程

```
PeerConnectionManager 创建 PC
  → 创建 PCStatsCollector(pc)
  → collector.start(snapshot => store.dispatch(updateDebugStats(snapshot)))
  → PCStatsCollector 每 2s:
      pc.getStats() → 解析 RTCStatsReport → 提取候选人/传输/通道数据
      → 构建 PCStatsSnapshot → 回调
  → DebugPanel 订阅 store → 实时渲染
  → PeerConnectionManager 连接状态变化时:
      collector.logTimeline({ ts, type, detail })
```

### 14.4 对方状态同步

对方在线状态已通过 WS 获取。额外通过心跳 RTT 估算对方连接质量：

```
心跳 RTT（通过 sync:heartbeat echo 计算）:
  < 100ms:  🟢 良好
  100-500ms: 🟡 一般
  > 500ms:   🔴 较差
```

显示在概况 Tab 的「对方网络质量」行。

---

## 十五、部署策略：开发 → 服务器测试

### 15.1 为什么需要远程测试

WebRTC 在 `localhost` 的问题：

| 场景 | localhost | 服务器 |
|------|-----------|--------|
| ICE 候选 | 只有 host 候选（127.0.0.1） | 收集 host + srflx + relay |
| NAT 穿透 | 无 NAT，永远选 host | 真正测试打洞 |
| TURN 中转 | 永远不走 TURN | 对称型 NAT 时触发 |
| 跨网络延迟 | 无延迟 | 真实网络延迟 |
| `getDisplayMedia` | 可测试 | 可测试 ✅ |

**结论**：基本功能开发可在本地验证，但 ICE 路由验证、TURN 测试必须部署到服务器。

### 15.2 部署流

```
开发 (本地 localhost:3000)               测试 (服务器 150.158.149.24)
                                        
编写功能 → 本地验证基本逻辑              →
          → git push                    →
                                        → ssh 服务器 → git pull
                                        → docker compose up -d --build
                                        → 双浏览器测试真实 WebRTC
```

### 15.3 部署文件（放在项目根目录）

#### `docker-compose.yml`

```yaml
version: '3.8'
services:
  samemoon:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "4000:4000"
    environment:
      - NODE_ENV=production
      - TURN_KEY_ID=${TURN_KEY_ID}
      - TURN_API_TOKEN=${TURN_API_TOKEN}
    restart: unless-stopped
```

#### `Dockerfile`（多阶段构建）

```dockerfile
# 构建阶段
FROM node:22-alpine AS builder
WORKDIR /app
COPY client/ client/
COPY server/ server/
RUN cd client && npm ci && npm run build
RUN cd server && npm ci && npm run build

# 运行阶段
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/client/dist ./client/dist
EXPOSE 4000
CMD ["node", "server/dist/index.js"]
```

#### 服务器 `.env`（`~/app-configs/same-moon/.env`）

```bash
TURN_KEY_ID=73ea334142af06b9d8f835e31d0fc1f4
TURN_API_TOKEN=3674f6a26801b3b524aba83575662ce9673dc8a8f07b3267635021bd3c95e2df
```

#### `deploy.sh`（本地一键部署脚本）

```bash
#!/bin/bash
set -e
echo "🚀 部署 SameMoon 到服务器..."
echo "1/3 推送代码..."
git push
echo "2/3 SSH 到服务器..."
ssh root@150.158.149.24 << 'EOF'
  cd ~/app-configs/same-moon
  git pull
  docker compose up -d --build
  echo "3/3 等待服务启动..."
  sleep 3
  docker compose logs --tail 10
  echo "✅ 部署完成: http://150.158.149.24:4000"
EOF
```

### 15.4 部署时机

| 开发阶段 | 是否部署 | 说明 |
|---------|:---:|------|
| Step 1 基础设施 | ✅ 首次部署 | 搭建 Docker 环境 + TURN 环境变量 |
| Step 1 开发中 | ❌ 本地 | 单元测试覆盖 |
| Step 2 屏幕分享 | ✅ 每次功能完成 | 验证 ICE 候选和流传输 |
| Step 3 文件传输 | ✅ 每次功能完成 | 验证跨网络传输 |
| Step 4 MSE 优化 | ✅ | 验证流式播放 |

### 15.5 快速测试命令

```bash
# 查看日志（实时）
ssh root@150.158.149.24 'cd ~/app-configs/same-moon && docker compose logs -f'

# 重启服务
ssh root@150.158.149.24 'cd ~/app-configs/same-moon && docker compose restart'

# 回滚（git revert + 重新部署）
git revert HEAD && git push && ./deploy.sh
```

---

## 十六、与 Stage 1 的关系

- **完全兼容**：现有 `local-sync` 模式零改动
- **SyncEngine 复用**：文件传输完成后走现有同步引擎
- **PlaybackAdapter 扩展**：新增 `webrtc-stream` source 类型
- **协议增量**：新增消息类型，不修改现有消息
- **信令复用**：WS 连接和转发机制不变
