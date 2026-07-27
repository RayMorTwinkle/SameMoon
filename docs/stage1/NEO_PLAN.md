# Same Moon — NEO 计划文档（v2）

> 本文件取代 PLAN.md 成为**唯一权威计划**。PLAN.md 保留作历史记录，冲突处以本文件为准。
> 深度技术实现规格（同步引擎算法、适配器接口、服务端加固等）见 **TECH-SPEC.md**——实现相关功能前必读。

---

## 1. 项目概述

**定位**：面向异地情侣/朋友的"一起看"Web 应用。双方通过 P2P/WebSocket 实时同步播放进度与浏览行为，营造"同处一室"的陪伴体验。

**三种观看模式**（按实现顺序）：

| 模式 | 内容来源 | 状态 |
|------|----------|------|
| ① 本地文件模式 | 双方各自持有同一个视频文件，本地播放 | MVP，开发中 |
| ② 在线视频模式 | 粘贴视频直链（mp4/m3u8）或 YouTube 链接，页面内同步播放 | Phase 3 |
| ③ 共同浏览模式 | 同步浏览任意网页（含其中的视频） | 远期，需自研客户端，见 §14 |

**核心原则**：
- 文件不上传服务器，本地播放（隐私 + 零带宽成本）
- P2P 直连优先（IPv6 + STUN），服务器仅做信令中转；TURN 接口预留不实现
- 零注册、零安装，打开链接即用
- 手机 + 电脑响应式兼容

---

## 2. 功能设计

### 2.1 核心用户流程（本地文件模式）

```
A 打开网站 → 创建房间 → 获得 4 位房间号 + 链接
→ A 把链接发给 B → B 打开链接自动加入
→ 双方各自选择本地电影文件 → 校验文件名+大小一致
→ 双方点击"准备好了"（获取浏览器自动播放授权，见 TECH-SPEC §2.4）
→ 进入同步播放（任一方 play/pause/seek，另一方自动跟随）
```

### 2.2 在线视频模式流程（Phase 3）

```
房间内任一方粘贴视频 URL → 系统识别类型（直链 mp4 / HLS m3u8 / YouTube）
→ 双方页面内加载同一视频源 → 同一套同步引擎接管
```

- 识别规则与适配器实现见 TECH-SPEC §4
- 防盗链（Referer 校验）的直链会加载失败，必须给出明确提示

### 2.3 文件验证机制

- 浏览器 `<input type="file">` 取得本地读取权限，`URL.createObjectURL(file)` 本地播放，不经网络
- 验证：文件名精确匹配 + 文件大小字节级匹配；不做完整哈希（4GB 算 hash 需数分钟）
- 可选增强（非 MVP）：头尾各 1MB 快速哈希二次确认
- **刷新后 objectURL 失效**，必须引导用户重新选择同一文件（TECH-SPEC §3.3）

### 2.4 同步播放协议（概要）

完整算法见 TECH-SPEC §1，要点：
- 状态模型 `{paused, time, rate, seq, senderId}`，seq 单调递增解决双方同时操作冲突
- NTP 式时钟校准（5 次采样取中位数），心跳每 5s 复用采样
- 回声抑制：程序化操作不得再次广播（`applyingRemote` 标志）
- 漂移三档校正：<0.3s 忽略；0.3~2s 变速追赶（±5% playbackRate）；>2s 才 seek
- 缓冲协商：一方 buffering 时另一方暂停等待

### 2.5 附加功能

| 功能 | 优先级 | 阶段 |
|------|--------|------|
| 内置文字聊天 | 高 | Phase 4 |
| 弹幕模式（聊天消息飘过视频画面，聊天的展示变体） | 低 | Phase 4 |
| 语音通话（WebRTC 音频，接口已预留） | 高 | Phase 5 |
| 字幕文件同步加载 | 中 | Phase 4 |
| "3-2-1 一起播放"倒计时 | 中 | Phase 4 |
| 链接跟随（共同浏览 L1，见 §14） | 中 | Phase 4 |

---

## 3. 架构设计

### 3.1 通信架构

```
用户A ◄──WebSocket(信令)──► 服务器 ◄──WebSocket(信令)──► 用户B
用户A ◄═══════ WebRTC DataChannel（P2P直连）═══════► 用户B
```

- 服务器：信令转发 + 房间管理，极轻量
- `sync:*` / `chat:*` / `browse:*`：P2P 建立后走 DataChannel，未建立时服务器转发，**消息格式完全一致**
- 媒体数据永不经过服务器

### 3.2 P2P 连接流程（Phase 2）

```
1. 双方在房间内 → 服务器通知发起方（房主）创建 RTCPeerConnection
2. offer/answer/ICE candidate 通过 rtc:* 消息经服务器转发
3. 优先 IPv6 host candidate 直连 → 失败尝试 STUN srflx 打洞
4. 15s 未连通 → 报错提示，同步自动降级走 WebSocket（功能不中断）
```

实现规范（perfect negotiation 模式、DataChannel 配置）见 TECH-SPEC §7。

### 3.3 连接层与语音接口（预留，不可删除）

```typescript
interface TransportStrategy {
  connect(peerId: string): Promise<Connection>;
  disconnect(): void;
  onStateChange(cb: (state: ConnectionState) => void): void;
}
// 现有：WebSocket 兜底；Phase 2：IPv6/STUN；未来：TurnTransport

interface VoiceChannel {
  join(roomId: string): Promise<void>;
  leave(): void; mute(): void; unmute(): void;
  onPeerJoined(cb: (peerId: string) => void): void;
  onPeerLeft(cb: (peerId: string) => void): void;
}
// UI 预留 disabled 按钮 + tooltip "即将上线"
```

### 3.4 WebSocket 消息协议（与代码同步的权威版本）

统一格式：`{ type, room?, from?, seq?, data }`

**已实现**：

| type | 方向 | data |
|------|------|------|
| `connected` | S→C | `{ userId }`（连接建立即下发） |
| `room:create` | C→S | `{}` |
| `room:created` | S→C | `{ roomCode, role: 'host' }` |
| `room:join` | C→S | `{ roomCode }` |
| `room:joined` | S→C | `{ userId, role, peerCount, rejoin }`（回给加入者本人） |
| `room:peer-joined` | S→C | `{ userId }`（广播给房内其他人） |
| `room:left` | S→C | `{ userId }` |
| `file:info` | C→S | `{ name, size }` |
| `file:match` | S→C | `{ matched, diff? }` |
| `sync:play` / `sync:pause` / `sync:seek` | C↔C | `{ time, timestamp }` |
| `sync:rate` | C↔C | `{ rate, timestamp }` |
| `sync:heartbeat` | 双向 | 请求 `{ clientTime, time, paused, rate }`；响应额外 `{ echoOf, t1 }`（t0=clientTime, t1=接收时刻, t2=clientTime） |
| `sync:state` | C↔C | 请求 `{}`；响应 `{ paused, time, rate, seq, senderId, sentAt }` |
| `sync:buffering` | C↔C | `{ time }`（对方在缓冲，己方暂停等待） |
| `sync:ready` | C↔C | `{ time }`（对方缓冲结束，对齐恢复） |
| `player:ready` | C↔C | `{}`（"准备好了"授权完成，通知对方） |
| `chat:message` | C↔C | `{ text }`（≤500字符） |
| `error` | S→C | `{ code, message }` |

**待实现**（实现对应 Phase 时加入，字段定义见 TECH-SPEC）：

| type | 方向 | 用途 | 阶段 |
|------|------|------|------|
| `rtc:offer` / `rtc:answer` / `rtc:ice` | C→S→C | WebRTC 信令 | Phase 2 |
| `source:set` | C↔C | 设置在线视频源 `{ kind, url }` | Phase 3 |
| `browse:navigate` | C↔C | 链接跟随 `{ url }` | Phase 4 |

**已实现（Step 5）**：

| type | 方向 | data |
|------|------|------|
| `session:hello` | C→S | `{ sessionId }`（连接后第一条消息） |
| `session:restored` | S→C | `{ sessionId, roomCode, role, roomState, peerOnline, fileName?, fileSize? }` |

**协议纪律**：新增消息类型必须同步更新本表 + server/src/ws/protocol.ts + 集成测试。

### 3.5 房间生命周期

| 项 | 值 |
|----|-----|
| 房间号 | 4 位数字；房间总数上限 5000（超出拒绝创建） |
| 无人加入超时 | 2 小时销毁 |
| 最大人数 | 2 人 |
| 断线重连窗口 | 30s（基于 sessionId，见下） |
| 双方离开 | 立即销毁 |
| 心跳 | 5s 间隔；15s 无响应判掉线 |

**重连设计（重要——当前实现每次连接分配新 userId，无法恢复，需按此改造）**：
客户端生成 `sessionId`（crypto.randomUUID）存入 sessionStorage；连接后先发 `session:hello {sessionId}`；服务端以 sessionId 为用户身份键。断线时用户标记"待移除"并启动 30s 定时器，同 sessionId 重连则取消定时器、换绑新 ws、下发 `session:restored`（含房间状态）。详见 TECH-SPEC §3。

状态机：

```
[等待中] → 对方加入 → [选文件中] → 验证通过+双方就绪 → [播放中]
                                       ↓ 一方掉线              ↓ 一方掉线
                                   [等待重连] ←──────────────────┘
                                       ↓ 30s 超时
                                    [已关闭]
```

---

## 4. 技术栈（与代码一致）

| 层 | 选型 | 备注 |
|----|------|------|
| 前端 | React 19 + TypeScript + Vite 8 | — |
| 样式 | TailwindCSS 4（`@tailwindcss/vite` 插件，**无 tailwind.config 文件**） + animal-island-ui | |
| 路由 | react-router-dom 7 | 导航传状态用 route state |
| 播放器 | ArtPlayer | 集成规范见 TECH-SPEC §2 |
| HLS | hls.js（Phase 3 引入） | Safari 原生支持 m3u8 可跳过 |
| 图标 | animal-island-ui Icon + lucide-react | 全 SVG，禁 emoji |
| 实时通信 | 原生 WebSocket（全局 Context 单连接） | hooks/useWebSocket.tsx |
| P2P | 原生 RTCPeerConnection（不用 PeerJS，减少黑盒） | Phase 2 |
| 后端 | Node.js + Fastify 5 + @fastify/websocket 11.3.0（**12.x 不存在**） | |
| 测试 | vitest（服务端 12 个测试已通过）+ Playwright（待加） | |
| 根脚本 | `npm run dev` = concurrently 起前后端（3000/4000） | 3000 被占会自动换 3001 |

---

## 5. UI/UX 规范

- 布局草图：`wireframe.html`（6 页面），仅定功能布局非最终视觉
- 组件库 animal-island-ui：入口必须先 `import 'animal-island-ui/style'`；写代码查其 `AI_USAGE.md`（props 权威），样式细节查 `skill/SKILL.md`；本地有 `me-animal-island-ui` skill
- **图标禁用 emoji**，用 animal-island-ui Icon（10个）+ lucide-react，颜色 `#794f27`，尺寸 16/20/24px
- 配色：主色 `#19c8b9`、主文字 `#794f27`、正文 `#725d42`、背景 `#f8f8f0`、边框 `#c4b89e`
- 断点：<640 手机 / 640-1024 平板 / >1024 桌面
- 原则：圆润温暖低压迫；操作步骤最少；连接/同步/对方状态即时可见

---

## 6. 异常处理

### 6.1 全景表

| 场景 | 用户提示 | 技术处理 |
|------|----------|----------|
| 文件格式不支持 | "该格式浏览器无法播放，建议 .mp4/.webm/.mkv(Chrome)" | 白名单校验，选择时拦截 |
| 双方文件不一致 | "文件不匹配：你的 4.2GB，对方 4.1GB，请确认同一版本" | name+size 对比，展示差异 |
| 浏览器禁止自动播放 | 引导双方点"准备好了"按钮 | 用户手势解锁 play() 权限 |
| 一方缓冲卡顿 | "TA 的网络在缓冲，已为你暂停等待…" | sync:buffering 协商 |
| 双方同时操作 | 静默按 seq 规则取胜者 | last-writer-wins，见 TECH-SPEC §1.5 |
| 解码漂移 | 静默变速校正；>2s "正在重新同步…" | 三档校正 |
| 刷新页面 | "请重新选择文件：xxx (4.2GB)" | sessionId 恢复房间，文件重选 |
| P2P 连接失败 | "直连失败，已自动切换服务器转发（可能稍有延迟）" | 15s 超时降级 WS，不中断功能 |
| IPv6 不可用 | 调试面板显示，不打扰用户 | ICE candidate 类型判断 |
| 对方掉线 | "对方已断开，等待重新加入…（30s）" | 心跳超时 + 重连窗口 |
| WebSocket 断开 | "连接中断，正在重连…（第 N 次）" | 指数退避，最多 5 次 |
| 房间不存在/已满 | "房间已关闭或链接无效" / "房间已满" | 服务端校验 |
| 在线直链防盗链/CORS | "该链接受站点保护无法播放，试试其他来源" | video onerror 检测 |
| YouTube 视频不可嵌入 | "该视频不允许站外播放" | IFrame API onError 101/150 |
| iOS 后台暂停 | "请保持屏幕常亮并留在本页" | UA 检测提示 |

### 6.2 格式白名单

视频：`.mp4 .webm .m4v .mov(Safari) .mkv(仅Chrome/Edge)`；字幕：`.srt .vtt`

### 6.3 错误提示原则

说人话 / 说原因 / 说方案 / 分级（可恢复→Notification，需操作→内联+按钮，不可恢复→Modal 阻断）。禁止把 "ICE candidate gathering failed" 之类直接给用户。

---

## 7. 开发规范

### 7.0 开发教训（踩过的坑，必读）

1. **跨页面消息消费**：WS 消息被页面 A 消费后导航，页面 B 信息丢失 → 路由 state 传关键状态（role 等）
2. **服务端必须幂等**：重复 join 不得改角色/人数/触发广播；所有"加入/创建"类接口防重
3. **修 bug 先走完整消息链路**（谁发→谁收→时序）找根因，不修表面现象
4. **每次修 bug 必须加回归测试**（server/test/ 已有 vitest + 真实 ws 客户端模式）
5. **端到端才算完成**："编译通过"≠"能用"，必须双窗口实测用户流程
6. **回声抑制**：程序化 seek/play 会触发本地事件再广播 → 死循环。任何同步逻辑先写 `applyingRemote` 防护（TECH-SPEC §1.3）
7. **Vite WS 代理**：target 用 `http://` + `changeOrigin: true`，不是 `ws://`
8. **React StrictMode 双挂载**：WS 清理时先 `onclose = null` 再 close，防竞态重连

### 7.1 结构化日志

所有日志含 `module + action + state + detail + suggestion`（格式见 PLAN.md §7.1，不变）。

### 7.2 测试与 CI

- 服务端：vitest 单元 + ws 集成测试，**修改服务端逻辑后必须 `cd server && npm test` 全绿**
- 同步引擎：纯逻辑单测（伪造时钟+传输，不依赖 DOM），Phase 1 Step 4 起
- E2E：Playwright 双 browser context 模拟两名用户（TECH-SPEC §8）
- CI：GitHub Actions，push 时跑 tsc（前后端）+ 服务端测试

### 7.3 命名与代码

组件 PascalCase / 工具 camelCase / 常量 UPPER_SNAKE；Tailwind utility-first；聊天内容只作为 React 文本节点渲染（自动转义），**禁止 dangerouslySetInnerHTML**。

---

## 8. 项目结构（现实 + 计划）

```
SameMoon/
├── NEO_PLAN.md                # 本文件（权威计划）
├── TECH-SPEC.md               # 实现规格书（算法/接口/加固细节）
├── PLAN.md                    # 历史版本，仅存档
├── wireframe.html             # 界面草图
├── package.json               # npm run dev 一键起前后端
├── client/
│   ├── vite.config.ts         # 端口3000 + /ws 代理 + tailwind 插件
│   └── src/
│       ├── main.tsx           # animal-island-ui/style + Router + WsProvider
│       ├── App.tsx            # 路由: / 和 /room/:code
│       ├── hooks/
│       │   ├── useWebSocket.tsx   # 全局 WS Context（已有）
│       │   └── usePlayerSync.ts   # (Step 4) 播放器同步 hook
│       ├── components/
│       │   ├── Room/          # HomePage.tsx / RoomPage.tsx（已有）
│       │   ├── Player/        # (Step 4) PlayerPage / 控件
│       │   ├── Chat/          # (Phase 4)
│       │   └── common/        # (Step 5) DebugPanel / ErrorBoundary
│       ├── services/
│       │   ├── sync/          # (Step 4) SyncEngine.ts + ClockSync.ts
│       │   ├── playback/      # (Step 4) PlaybackAdapter.ts + LocalFileAdapter.ts
│       │   │                  # (Phase 3) DirectUrlAdapter / YouTubeAdapter
│       │   ├── transport/     # (Phase 2) rtc 连接策略 + TurnTransport 空实现
│       │   └── voice/         # VoiceChannel 接口空实现
│       └── utils/             # (Step 3) fileValidator / formatFileSize / logger
└── server/
    ├── src/
    │   ├── index.ts           # 入口（仅 listen）
    │   ├── app.ts             # buildApp（可测试，全部路由/WS 逻辑）
    │   ├── room/RoomManager.ts
    │   └── ws/protocol.ts     # 消息类型定义
    └── test/                  # RoomManager.test.ts + integration.test.ts（12个已过）
```

---

## 9. 开发计划

### Phase 1：本地文件模式 MVP（进行中）

- [x] Step 1 前后端初始化（React19+Vite8+Tailwind4+animal-island-ui / Fastify+ws）
- [x] Step 2 房间系统（创建/加入/链接分享/幂等防重/12 个测试）
- [x] Step 3 文件选择 + 验证 UI（后端 file:info/file:match 已就绪）：拖拽/点击选择、白名单校验、大小格式化、匹配状态展示、不匹配差异提示
- [x] Step 4 播放器 + 同步引擎：ArtPlayer + LocalFileAdapter + SyncEngine（按 TECH-SPEC §1、§2 实现，含"准备好了"授权按钮、缓冲协商、sync:state 追齐）
- [x] Step 5 会话恢复 + 错误处理收尾：sessionId 重连（TECH-SPEC §3）、服务端加固（TECH-SPEC §6）、调试面板、ErrorBoundary

**验收**：两台设备完整走通：创建→加入→选同一文件→同步播放/暂停/拖动；刷新一方 30s 内恢复；故意选错文件有清晰提示。

### Phase 2：P2P 直连

- [ ] rtc:* 信令 + RTCPeerConnection（perfect negotiation，TECH-SPEC §7）
- [ ] DataChannel 承载 sync/chat，断开自动降级 WS（用户无感）
- [ ] 连接质量显示（直连/中转、RTT）+ 调试面板 ICE 日志

**验收**：两台不同网络的 IPv6 设备 P2P 直连；禁用 IPv6 后自动降级 WS 且同步不中断。

### Phase 3：在线视频模式

- [ ] PlaybackAdapter 抽象落地（LocalFile 重构为适配器之一）
- [ ] DirectUrlAdapter（mp4/webm + hls.js 播 m3u8）+ source:set 消息
- [ ] YouTubeAdapter（IFrame Player API）
- [ ] URL 识别 + 防盗链/不可嵌入错误处理

**验收**：粘贴 mp4 直链和 YouTube 链接均可双端同步播放。

### Phase 4：体验完善

- [ ] 文字聊天 + 弹幕模式 + 字幕加载 + 倒计时
- [ ] 链接跟随（共同浏览 L1：browse:navigate + 手动"跟随打开"按钮，弹窗拦截约束见 TECH-SPEC §5.1）
- [ ] 响应式打磨 + PWA + 完整异常覆盖

### Phase 5：语音 + TURN

- [ ] VoiceChannel 实现（WebRTC 音频轨复用现有 PeerConnection）
- [ ] TurnTransport（自建 coturn 或商用 TURN）

### Phase 6：共同浏览完全体（自研客户端，见 §14）

---

## 10. 部署方案

轻量应用服务器 2核2G + Docker Compose（Nginx 静态 + Node 后端）+ Caddy/Let's Encrypt HTTPS + 公共 STUN（stun.l.google.com:19302）起步。信令流量极小。生产强制 WSS。升级触发条件：做服务器中继直播（不在当前规划内）。

---

## 11. 开源依赖清单

| 依赖 | 用途 | 许可 |
|------|------|------|
| animal-island-ui | UI 组件库 | CC BY-NC 4.0（**非商用**，商业化需替换） |
| lucide-react | SVG 图标 | ISC |
| ArtPlayer | 播放器 | MIT |
| hls.js（Phase 3） | HLS 播放 | Apache-2.0 |
| react-router-dom | 路由 | MIT |
| Fastify / @fastify/websocket / @fastify/cors | 后端 | MIT |
| vitest / Playwright | 测试 | MIT |
| concurrently | 一键启动 | MIT |

---

## 12. 已知限制

| 限制 | 应对 |
|------|------|
| .mkv 仅 Chrome/Edge | 提示换浏览器或转 mp4 |
| iOS 后台暂停视频 | PWA + 前台提示 |
| 无 TURN 时 15-30% 网络无法 P2P | 自动降级 WS 转发（功能不断） |
| 4 位房间号可枚举 | 按 IP 限制 join 频率（TECH-SPEC §6） |
| 仅 2 人 | 多人需重构房间模型（远期） |
| 浏览器自动播放策略 | "准备好了"手势授权流程 |
| 任意网站共同浏览在纯 Web 端不可行 | 见 §14 自研客户端路线 |

---

## 13. 安全与隐私

- 文件永不上传；无账号无数据库；房间自动销毁
- 生产 HTTPS/WSS 强制
- 服务端加固：消息≤4KB、每连接限速、roomCode 正则校验、聊天≤500字符、join 频率限制、房间总数上限（具体数值 TECH-SPEC §6）
- 聊天渲染仅文本节点，防 XSS

---

## 14. 共同浏览完全体：自研客户端方案（远期，本节为设计备忘）

### 14.1 为什么纯 Web 做不到

- 主流网站用 `X-Frame-Options` / `CSP frame-ancestors` 禁止被 iframe 嵌入
- 跨域 iframe 内的跳转、点击、视频状态，父页面**无法读取**（同源策略）
- 服务端代理重写（Ultraviolet 式）虽可行，但带宽成本高、重 JS 站点易坏、有 SSRF 与法律风险——**不走此路线**

### 14.2 选定路线：自己控制浏览器环境

自己做"浏览器"，同源策略就不再是障碍。两个递进形态：

**形态 A：桌面浏览器扩展（先做，成本低）**
- Chrome/Edge MV3 扩展：content script 注入到任意页面 = 与页面同环境，可监听一切
- content script 职责（与形态 B 共用同一份"同步 Agent 脚本"）：
  1. 监听导航：`history.pushState/replaceState` hook + `popstate` + 页面加载，上报 `browse:navigate {url}`
  2. 发现视频：`document.querySelectorAll('video')` + `MutationObserver` 监听动态插入 + 遍历同源 iframe
  3. 挂视频事件 play/pause/seeking/ratechange → 上报 `sync:*`（带回声抑制）
  4. 接收远端命令并施加到本地 video 元素
- 通信：content script ↔ background service worker ↔ 直连 SameMoon 房间 WebSocket（复用现有协议，房间号在扩展 popup 里输入）
- 限制：DRM 站点（Netflix 等）video 元素可控但内容加密不影响 play/pause/seek 同步；双方都需登录各自账号（合法合规：各用各的会员）

**形态 B：Android 自研浏览器 App（完全体）**
- 技术选型（按推荐顺序）：
  1. **Kotlin + WebView**：原生 WebView 全权控制，最稳
  2. Tauri v2 mobile / Capacitor + WebView：可复用 Web 技术栈，桥接能力稍弱
- 核心机制：
  - `WebViewClient.shouldOverrideUrlLoading` / `onPageStarted` 捕获一切导航 → 广播给对方，对方 WebView `loadUrl` 跟随
  - `evaluateJavascript` 向每个页面注入形态 A 的同一份同步 Agent 脚本；`addJavascriptInterface` 建立 JS↔原生桥
  - 原生层维持房间 WebSocket 连接（协议与 Web 端完全一致，服务器零改动）
  - SPA 站内跳转由 Agent 脚本的 history hook 捕获（WebViewClient 抓不到）
- 体验设计：
  - 双方各自登录自己的网站账号（Cookie 隔离在各自设备，隐私安全）
  - 页面内容可能因账号/广告/推荐不同而不一致 → **以视频时间轴为同步基准，不同步页面滚动等易发散状态**（滚动同步做成可选开关）
  - 一方跳转时对方弹"TA 去了 xxx，跟随？"确认条（防误跳、防恶意链接）
- 挑战备忘：
  - iOS 版需 WKWebView，注入用 `WKUserScript`，能力类似可行
  - 部分站点检测 WebView UA 降级功能 → 可自定义 UA 伪装常规 Chrome
  - DRM（Widevine L3）在 WebView 中通常可用，L1 依设备而定
  - 分发：个人使用可 APK 侧载，无需上架

### 14.3 复用资产

服务器、房间协议、`sync:*`/`browse:*` 消息、同步引擎算法（TECH-SPEC §1）**全部复用**；客户端只是把"PlaybackAdapter"换成"WebView 桥接 Adapter"。因此 Phase 3 把适配器接口抽象做扎实，就是在为这一步铺路。

---

## 15. 待讨论方向

| 话题 | 何时 |
|------|------|
| STUN 自建 coturn vs 公共服务 | Phase 2 |
| PWA 图标/名称/离线页 | Phase 4 |
| 法律免责声明文案 | 上线前 |
| 视觉美学打磨（当前只有线框） | Phase 4 |
| 多人（>2）房间模型 | 远期 |
| 扩展/App 的同步 Agent 脚本工程化 | Phase 6 前 |

---

## 16. 给 AI 的开发提示

1. **先读本文件，再读 TECH-SPEC.md 对应章节**，不要自行发挥架构
2. 实现同步播放/在线视频/共同浏览前，**必须**按 TECH-SPEC 的算法与接口做，那里有防呆细节（回声抑制、自动播放授权、幂等、限流数值）
3. UI 用 animal-island-ui（查其 AI_USAGE.md），图标 SVG 禁 emoji
4. 改服务端必须跑 `cd server && npm test` 全绿；修 bug 必须加回归测试
5. 每完成一个 Step：双窗口端到端验证 → 更新本文件勾选框 → git commit 推送
6. 预留接口（TurnTransport/VoiceChannel）不可删除
7. 协议变更三处同步：本文件 §3.4 + server/src/ws/protocol.ts + 集成测试
