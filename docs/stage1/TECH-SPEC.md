# Same Moon — 技术实现规格书（TECH-SPEC）

> 配套 NEO_PLAN.md 使用。本文件回答"具体怎么写代码"，含算法、伪代码、精确数值、常见错误。
> **实现任何同步/重连/在线视频/共同浏览功能前，必须先读对应章节。**
> 伪代码仅表达逻辑，落地时按项目 TS 风格实现。

---

## 1. 同步引擎规格（SyncEngine）

### 1.1 状态模型

```typescript
interface PlaybackState {
  paused: boolean;
  time: number;       // 视频时间轴位置（秒）
  rate: number;       // 倍速
  seq: number;        // 单调递增序号（每次本地用户操作 +1）
  senderId: string;   // 操作发起者 userId
  sentAt: number;     // 发送方"校准后时钟"时间戳（ms）
}
```

- `seq` 双方各自维护本地计数器，初始 0；**收到远端 state 时取 `max(本地seq, 远端seq)`**，保证全局单调
- 每条 `sync:*` 消息都携带完整 `PlaybackState`（不要只发增量，全量幂等更抗丢包）

### 1.2 时钟校准（NTP 式）

两台设备的 `Date.now()` 有偏差（可达数秒），直接用对方时间戳计算会错。必须先估算时钟偏移：

```
采样一次：
  t0 = 本地发送时刻
  t1 = 对方接收时刻（对方回包携带）
  t2 = 对方回复时刻（对方回包携带）
  t3 = 本地收到回包时刻
  offset = ((t1 - t0) + (t2 - t3)) / 2     // 对方时钟 - 本地时钟
  rtt    = (t3 - t0) - (t2 - t1)
```

**流程**：
1. 进入房间后立即连续采样 **5 次**（间隔 200ms），取 **rtt 最小的 3 次的 offset 中位数** 作为 `clockOffset`
2. 之后每次 `sync:heartbeat`（5s 一次）复用采样，滑动窗口保留最近 10 个样本，持续修正
3. 换算：`对方时刻的本地表示 = 对方时间戳 - clockOffset`

**常见错误**：直接 `Date.now() - msg.timestamp` 当延迟用（混入了时钟偏差）；只采样一次（网络抖动导致偏差巨大）。

### 1.3 回声抑制（最重要，不做必死循环）

程序化调用 `player.seek()/play()/pause()` 会触发播放器事件 → 事件处理器又广播 → 对方再施加 → 无限循环。

```typescript
class SyncEngine {
  private applyingRemote = false;

  // 收到远端命令时：
  applyRemote(state: PlaybackState) {
    this.applyingRemote = true;
    try {
      adapter.seek(targetTime);
      state.paused ? adapter.pause() : adapter.play();
    } finally {
      // 注意：play()/seek() 的事件是异步触发的，同步 finally 置 false 太早！
      setTimeout(() => { this.applyingRemote = false; }, 150); // 等事件排空
    }
  }

  // 本地播放器事件处理器（play/pause/seek 都要）：
  onLocalPlayerEvent(evt) {
    if (this.applyingRemote) return;  // 回声，不广播
    this.broadcast(this.captureState());
  }
}
```

- 150ms 排空窗口是经验值；若测试发现仍有回声（如 seek 后紧跟 canplay+play），改为"事件计数器"方案：施加前登记预期事件数，处理器逐个消费
- **seek 目标时间要补偿传输延迟**：`targetTime = state.time + (校准后的当前时刻 - state.sentAt) / 1000 * (state.paused ? 0 : state.rate)`

### 1.4 漂移校正（三档）

播放中每 5s（复用心跳）交换当前 `time`，计算补偿后的偏差 `drift`：

| |drift| | 动作 |
|---------|------|
| < 0.3s | 忽略（人眼无感，频繁校正反而卡顿） |
| 0.3s ~ 2s | **变速追赶**：落后方 `playbackRate = 1.05`，领先方不动；追平（<0.1s）后恢复 1.0。禁止 seek（会卡顿跳变） |
| > 2s | 直接 seek 到补偿后的目标时间，并 toast "正在重新同步…" |

变速期间用户如果手动改倍速，以用户操作优先，放弃本轮追赶。

### 1.5 冲突解决（双方同时操作）

规则：**seq 大者胜；seq 相同时 senderId 字典序大者胜**。

```
收到远端 state:
  if (远端.seq > 本地.seq) → 接受，applyRemote，本地 seq = 远端.seq
  else if (远端.seq === 本地.seq && 远端.senderId > 本地.userId) → 接受
  else → 丢弃（自己的操作更新，且自己的广播已在路上）
```

本地每次用户操作：`seq = max(本地seq, 已知最大远端seq) + 1`，再广播。此规则保证双方最终收敛到同一状态，无需中央仲裁。

### 1.6 缓冲协商

一方网络慢导致 buffering 时，另一方继续播会越拉越远：

```
本地 video 'waiting' 事件 → 发送 sync:buffering {time}
对方收到 → adapter.pause()（applyingRemote 包裹）→ UI 显示"TA 的网络在缓冲…"
本地 'canplay' 事件 → 发送 sync:ready {time}
对方收到 → 双方按发起方的 time 对齐后恢复播放
超时保护：buffering 超过 30s → 提示"对方网络较差，你可以选择继续独立观看"（解除同步锁）
```

注意：`waiting` 在 seek 后也会触发，需与 §1.3 的抑制窗口配合，避免把自己 seek 引起的 waiting 广播出去。

### 1.7 状态追齐（重连/刷新后）

新连接/重连进入"播放中"房间 → 发送 `sync:state` 请求（data 空）→ 对方回复完整 `PlaybackState` + 当前 `seq` → 请求方施加（applyRemote）。若双方都无状态（都刚恢复），以 role=host 一方为准。

### 1.8 SyncEngine 与传输解耦

```typescript
interface SyncTransport { send(msg): void; onMessage(cb): void; }
```
Phase 1 传 WebSocket 实现；Phase 2 传 DataChannel 实现（断开自动换回 WS）。SyncEngine 本身**不允许 import 任何 WebSocket/RTC 代码**，便于纯逻辑单测（§8.2）。

---

## 2. ArtPlayer 集成规范

### 2.1 需要挂接的事件

| 事件 | 来源 | 处理 |
|------|------|------|
| `play` / `pause` | art 实例 | 回声检查 → 广播 |
| `seek` | art 实例 | 回声检查 → 广播（ArtPlayer 拖动结束触发） |
| `video:ratechange` | art.on | 回声检查 → 广播 sync:rate |
| `video:waiting` | art.on | §1.6 缓冲上报 |
| `video:canplay` | art.on | §1.6 就绪上报 |
| `video:error` | art.on | 结构化日志 + 用户提示（区分本地文件损坏 / 直链防盗链） |

### 2.2 已知坑

- `art.seek = t`（setter）会触发 `seek` 事件 → 必须在 applyingRemote 窗口内
- ArtPlayer 销毁：路由离开时必须 `art.destroy()`，否则重进房间出现双实例双声音
- React 集成：ArtPlayer 不是 React 组件，用 `useRef` + `useEffect(() => { new Artplayer(...); return () => art.destroy(); }, [url])`，url 变化时全量重建

### 2.3 本地文件加载

```typescript
const url = URL.createObjectURL(file);   // 同步返回，极快
// 组件卸载或换文件时必须 URL.revokeObjectURL(url) 防内存泄漏
```

### 2.4 浏览器自动播放策略（必须处理，否则同步"看似能用实际必坏"）

浏览器禁止无用户手势的 `video.play()`。远端发来的 play 命令属于程序化调用，**首次会被拒绝**。

方案：文件验证通过后进入"准备"界面，双方各自点击**"准备好了"按钮**；点击处理器内执行一次 `player.play(); player.pause();`（消耗手势解锁播放权限），然后上报 `sync:ready`。双方都 ready 后才允许进入同步播放。此后程序化 play() 不再被拦截。

`play()` 返回 Promise，**必须 catch**：被拒绝时 UI 提示"点击画面开始播放"。

---

## 3. 会话恢复（sessionId）设计

### 3.1 当前问题

服务端以"每次 WS 连接随机分配的 userId"为身份 → 刷新即新用户，房间被销毁，无法恢复。

### 3.2 目标设计

**客户端**：
```typescript
// 每个标签页一个稳定身份（sessionStorage 天然按 tab 隔离且刷新保留）
let sessionId = sessionStorage.getItem('sm-session');
if (!sessionId) { sessionId = crypto.randomUUID(); sessionStorage.setItem('sm-session', sessionId); }
// WS onopen 后第一条消息：
send({ type: 'session:hello', data: { sessionId } });
```

**服务端**：
- 用户身份键从"连接"改为 sessionId：`Map<sessionId, UserRecord>`，UserRecord 含 `{ ws, roomCode, role, fileInfo, disconnectTimer? }`
- 连接建立后等待 `session:hello` 才认定身份（未 hello 前其他消息一律拒绝）
- **断开时**：不立即移除。标记离线，`disconnectTimer = setTimeout(30_000, 真正移除+广播 room:left+可能销毁房间)`；广播 `room:peer-offline`（对方 UI 显示"对方掉线，等待重连…"）
- **同 sessionId 重连**：清除 timer，换绑新 ws，回复 `session:restored { roomCode, role, roomState, peerOnline }`，广播 `room:peer-online`
- 幂等：同 sessionId 已在线又来新连接（多标签页复制）→ 拒绝并提示"该会话已在其他页面打开"

### 3.3 刷新后的文件恢复 UX

objectURL 刷新即失效，文件无法自动恢复。流程：`session:restored` 显示房间处于播放中 → UI 弹出"请重新选择文件：星际穿越.mkv (4.2GB)"（服务端在 UserRecord 里存了 fileInfo）→ 用户重选 → 本地校验 name+size 与之前一致 → 发 `sync:state` 请求追齐进度（§1.7）→ 恢复播放。选错文件则提示差异并要求重选。

### 3.4 回归测试要求

集成测试新增：hello→create→断开→30s 内以同 sessionId 重连→房间仍在且角色不变；30s 后重连→房间已销毁。测试中把 30s 窗口做成可配置（构造参数注入，测试传 100ms）。

---

## 4. PlaybackAdapter 接口（Phase 3 前落地）

### 4.1 接口定义

```typescript
type AdapterEvent = 'play' | 'pause' | 'seeked' | 'ratechange' | 'waiting' | 'canplay' | 'error' | 'ended';

interface PlaybackAdapter {
  load(source: PlaybackSource): Promise<void>;
  play(): Promise<void>;      // 必须透传 play() 的 rejection
  pause(): void;
  seek(time: number): void;
  setRate(rate: number): void;
  getTime(): number;
  getPaused(): boolean;
  on(evt: AdapterEvent, cb: (detail?: unknown) => void): () => void;  // 返回取消函数
  destroy(): void;
}

type PlaybackSource =
  | { kind: 'local-file'; file: File }
  | { kind: 'direct-url'; url: string }     // mp4/webm/m3u8
  | { kind: 'youtube'; videoId: string };
```

SyncEngine 只依赖此接口，**绝不直接 import ArtPlayer/YT**。

### 4.2 URL 识别规则（source:set 前在发送端判定）

```
/youtube\.com\/watch\?.*v=([\w-]{11})/ 或 /youtu\.be\/([\w-]{11})/ → youtube（提取 videoId）
/\.m3u8(\?|$)/ → direct-url (HLS：非 Safari 用 hls.js 挂载)
/\.(mp4|webm|m4v|mov)(\?|$)/ → direct-url
其他 → 拒绝并提示"暂不支持该链接类型"
```

### 4.3 DirectUrlAdapter 要点

- HLS：`Hls.isSupported()` 则 `hls.attachMedia(video)`；Safari 直接 `video.src = url`
- 防盗链/CORS 失败表现为 video error code 4 或 hls networkError → 友好提示，**不要**让弱模型去做代理绕过
- 双方网络不同，同一 URL 可能一方能播一方不能 → `source:set` 后双方各自回报加载结果，一方失败则提示换源

### 4.4 YouTubeAdapter 要点

- IFrame Player API：动态注入 `https://www.youtube.com/iframe_api` 脚本，`onYouTubeIframeAPIReady` 全局回调（注意只注入一次）
- 事件映射：`onStateChange`: PLAYING→play, PAUSED→pause, BUFFERING→waiting；**YT 没有独立 seek 事件**，用轮询（500ms）对比 `getCurrentTime()` 与预期位置，跳变 >1.5s 视为用户 seek
- `onError` 101/150 = 不允许嵌入 → 提示换视频
- 回声抑制同样适用（`player.seekTo()` 会触发状态变化）

---

## 5. 共同浏览

### 5.1 L1 链接跟随（Phase 4，纯 Web 可做）

- 房间内输入框粘贴 URL → 广播 `browse:navigate { url }`
- **弹窗拦截约束**：收到方不能直接 `window.open`（非用户手势必被浏览器拦截）→ UI 显示卡片"TA 想和你一起看：xxx.com [跟随打开]"，用户点击按钮（手势）才 open
- 安全：只允许 `http(s):` 协议，展示完整域名防钓鱼
- 打开后的标签页内行为无法追踪（跨域），这是 L1 的边界，不要尝试突破

### 5.2 L3 完全体（自研客户端，设计备忘见 NEO_PLAN §14）

核心组件"同步 Agent 脚本"（扩展 content script 与 WebView 注入共用一份），职责规格：

```
1. 导航监听：包装 history.pushState/replaceState + popstate + beforeunload 上报
2. 视频发现：querySelectorAll('video') + MutationObserver（子树），遍历同源 iframe；
   每个 video 分配稳定索引（DOM 路径），多视频时以"正在播放的那个"为同步对象
3. 事件挂接与回声抑制：完全复用 §1.3 模式
4. 桥接协议：Agent ↔ 宿主（扩展 background / WebView 原生层）之间用
   { channel: 'samemoon-agent', type, data } 消息；宿主负责连房间 WS
5. 同步基准：以视频时间轴为准；页面滚动/DOM 状态不同步（双方账号内容可能不同）
```

服务器与房间协议**零改动**即可支持客户端接入（同一套 WS 协议）。

---

## 6. 服务端加固清单（Phase 1 Step 5 实施，含精确数值）

| 项 | 数值/规则 | 违反处理 |
|----|-----------|----------|
| 单条消息大小 | ≤ 4KB | 丢弃 + error INVALID_SIZE |
| 消息频率 | 每连接 30 条 / 10s（滑动窗口） | 超出 close(1008) |
| roomCode 校验 | `/^\d{4}$/`，不匹配即拒 | error INVALID_ROOM |
| 聊天长度 | text ≤ 500 字符，去除控制字符 | 截断 |
| join 频率 | 每 IP 20 次/分钟 | error RATE_LIMITED（防 4 位房号枚举） |
| 房间总数 | ≤ 5000 | 拒绝创建，error SERVER_FULL |
| 未 hello 的连接 | 10s 内未发 session:hello → 断开 | close(1002) |
| JSON 校验 | 必须是 object（拒绝数组/原始值），type 必须 string | error INVALID_JSON |
| 转发消息白名单 | 只转发 sync:*/chat:*/rtc:*/browse:*/source:*，**其余一律不转发** | 静默丢弃 |

每一项都要有对应集成测试。

---

## 7. WebRTC P2P 实施规范（Phase 2）

- 信令消息：`rtc:offer { sdp }` / `rtc:answer { sdp }` / `rtc:ice { candidate }`，服务器纯转发（进 §6 白名单）
- 采用 **perfect negotiation** 模式（MDN 标准范式）：role=host 为 polite 端，避免 glare（双方同时 offer）
- 配置：`iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]`；DataChannel `label='samemoon'，ordered: true`
- 通道切换规则：DataChannel `open` → SyncTransport 切到 DC；`close/error` → 无缝切回 WS 并 toast 一次；**切换期间消息不丢**（发送前检查通道状态）
- 连接诊断日志：记录选中 candidate pair 类型（host-IPv6 / srflx / 失败），显示在调试面板
- 15s 未达 connected → 放弃 P2P，保持 WS，不再重试（本次会话）
- StrictMode 注意：PeerConnection 创建放在 Provider 级别或 ref 守卫，防双实例

---

## 8. 测试与 CI 规格

### 8.1 服务端（已有，持续维护）

`cd server && npm test`。现有 12 个测试必须始终全绿。新功能→先加集成测试再实现（room 恢复、限流、rtc 转发白名单）。

### 8.2 SyncEngine 纯逻辑单测（Step 4 同步交付）

因 §1.8 解耦，可注入伪时钟 + 内存传输测试：
- 两个引擎实例互连 → A play → B 状态收敛
- 同时操作（seq 冲突）→ 双方收敛到同一胜者
- 漂移 0.5s → 变速追赶不 seek；漂移 3s → seek
- 回声：applyRemote 后本地事件不触发广播

### 8.3 Playwright E2E（Phase 1 完成时建立）

双 `browser.newContext()` 模拟两人。场景清单：
1. A 创建 → B 经链接加入 → 双方看到对方在线
2. 双方选文件（`setInputFiles` 用仓库内小测试视频 fixtures/sample.mp4，几百 KB 即可）→ 匹配通过
3. A 播放 → 断言 B 的 video.paused === false；A 拖进度 → B currentTime 收敛
4. B 刷新 → 30s 内恢复房间 → 重选文件 → 进度追齐
5. 输错房间号 → 错误提示

### 8.4 GitHub Actions

`.github/workflows/ci.yml`：push/PR 触发 → 前后端 `npm ci` + `tsc --noEmit` + `cd server && npm test`。Playwright 手动触发或 nightly（免得每次 push 太慢）。

---

## 9. 分步实施指南（给执行模型的操作序列）

### Step 3 文件选择 UI

1. `utils/fileValidator.ts`：白名单后缀校验 + `formatFileSize`（1024 进制，保留 1 位小数）
2. RoomPage 内嵌文件选择区（对方加入后激活）：`<input type="file" accept="...">` + 拖拽（dragover 必须 preventDefault 否则 drop 不触发）
3. 选中 → 本地校验 → `send file:info` → 渲染"等待对方/匹配结果"三态（等待/✓/✗差异详情+重选按钮）
4. 双方 matched → 跳转/切换到播放视图（file 对象经 React 状态传递，**不能**放路由 state——File 不可序列化，用 Context 或状态提升到 RoomPage）
5. 验证：双窗口选同一文件 → 匹配；选不同文件 → 显示差异。commit

### Step 4 播放器 + 同步

1. 先写 `services/playback/PlaybackAdapter.ts` 接口 + `LocalFileAdapter`（ArtPlayer 封装，§2）
2. 再写 `services/sync/ClockSync.ts`（§1.2）+ `SyncEngine.ts`（§1.3-1.7），同步交付 §8.2 单测
3. 服务端补 `sync:state/buffering/ready` 转发（进白名单）+ 集成测试
4. "准备好了"授权流程（§2.4）→ 双 ready 进入播放
5. 验证：双窗口——播放/暂停/拖动互通；一方限速（DevTools Network throttle）触发缓冲协商；偏差校正生效。commit

### Step 5 会话恢复 + 加固

1. 按 §3 改造服务端身份模型（先写集成测试：重连恢复/超时销毁/多标签拒绝）
2. 客户端 hello 流程 + 刷新重选文件 UX（§3.3）
3. §6 加固清单逐项实现+测试
4. DebugPanel（WS 状态/时钟偏移/漂移值/最近 20 条日志）+ ErrorBoundary
5. 双设备（手机+电脑同局域网）完整验收 Phase 1。commit + 更新 NEO_PLAN 勾选

### Phase 2/3 开工前

重读本文件 §7 / §4，先定协议与测试再写实现；每个 Phase 结束更新 NEO_PLAN §9 勾选框并 commit。

---

## 10. 常见错误速查（执行模型自检清单）

- [ ] 广播了自己 applyRemote 引起的事件？（§1.3）
- [ ] 直接用对方 Date.now() 没过时钟校准？（§1.2）
- [ ] 小漂移用了 seek 导致画面跳变？（§1.4）
- [ ] play() 没 catch 自动播放拒绝？（§2.4）
- [ ] File 对象塞进路由 state？（不可序列化，§9 Step 3）
- [ ] objectURL 没 revoke？ArtPlayer 没 destroy？（§2.2/2.3）
- [ ] 服务端新消息类型没进转发白名单/没加测试？（§6）
- [ ] 修改服务端后没跑 npm test？
- [ ] 新增消息没同步 NEO_PLAN §3.4 协议表？
