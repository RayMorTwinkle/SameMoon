# Same Moon — 项目计划文档

> 本文档是项目的唯一权威参考。任何新对话/新 AI 接手时，读完此文件即可完整接续开发。

---

## 1. 项目概述

**定位**：面向异地情侣/朋友的"一起看"Web 应用。双方各自在本地播放同一部电影，通过 P2P 连接实时同步播放进度，营造"同处一室"的观影体验。

**核心原则**：
- 文件不上传服务器，仅在本地播放（隐私 + 零带宽成本）
- P2P 直连优先（IPv6 + STUN），服务器仅做信令中转
- 零注册、零安装，打开链接即用
- 手机 + 电脑响应式兼容

**目标用户**：异地情侣、异地好友（2 人场景为主）

---

## 2. 功能设计

### 2.1 核心用户流程

```
A 打开网站 → 创建房间 → 选择本地电影文件
→ 系统生成房间链接（如 https://samemoon.app/r/3847）
→ A 通过微信/QQ 发链接给 B
→ B 打开链接 → 浏览器提示"请选择：星际穿越.mkv (4.2GB)"
→ B 选择文件 → 系统校验文件名+大小一致
→ 进入同步播放（任一方操作，另一方自动跟随）
```

### 2.2 文件验证机制

- **不是上传**：浏览器通过 `<input type="file">` 获取本地文件读取权限
- **播放方式**：`URL.createObjectURL(file)` 生成本地 URL，不经过网络
- **验证方式**：文件名（精确匹配）+ 文件大小（字节级匹配）
- **不做完整哈希**：4GB 文件算 hash 需数分钟，体验不可接受
- **可选增强**：取文件头尾各 1MB 算快速哈希作为二次确认（非 MVP）

### 2.3 同步播放协议

```
房主操作 → WebSocket 广播 {action, time, timestamp}
各端收到 → 计算网络延迟 → 校正本地进度
每 5-10 秒自动交换时间戳 → 偏差 > 2s 时自动 seek 校正
```

同步指令集：`play` / `pause` / `seek` / `rate`（倍速）/ `load`（加载完成确认）

### 2.4 附加功能（MVP 后）

| 功能 | 优先级 |
|------|--------|
| 内置文字聊天 | 高 |
| 语音通话（WebRTC 音频） | 高（预留接口，暂不实现） |
| 字幕文件同步加载 | 中 |
| "3-2-1 一起播放"倒计时 | 中 |
| 播放历史/收藏 | 低 |

---

## 3. 架构设计

### 3.1 通信架构

```
┌─────────┐         WebSocket（信令）        ┌─────────┐
│  用户 A  │ ◄──────────────────────────────► │  服务器  │
└─────────┘                                  └─────────┘
     ▲                                            ▲
     │         WebSocket（信令）                   │
     │                                            │
┌─────────┐                                      │
│  用户 B  │ ◄────────────────────────────────────┘
└─────────┘
     ▲                                            
     │         WebRTC DataChannel（P2P 直连）      
     └──────────────────────────────────────────── A ↔ B
```

- **服务器角色**：仅信令转发 + 房间管理（极轻量）
- **媒体数据**：完全不经过服务器
- **播放同步**：优先走 P2P DataChannel，P2P 未建立时降级走 WebSocket 转发

### 3.2 P2P 连接流程

```
1. A 创建 RTCPeerConnection，配置 STUN 服务器
2. A 生成 offer → 通过 WebSocket 发给服务器 → 转发给 B
3. B 生成 answer → 回传
4. 双方交换 ICE candidate
5. 优先尝试 IPv6 直连（host candidate）
6. 失败则尝试 STUN 打洞（srflx candidate）
7. 均失败 → 报错提示（预留 TURN 降级入口，当前不实现）
```

### 3.3 连接层抽象（预留扩展）

```typescript
interface TransportStrategy {
  connect(peerId: string): Promise<Connection>;
  disconnect(): void;
  onStateChange(cb: (state: ConnectionState) => void): void;
  // 未来 TURN 只需新增 TurnTransport 实现此接口
}

// 当前实现：IPv6DirectTransport / StunTransport
// 未来实现：TurnTransport
```

### 3.4 语音通话预留接口

```typescript
interface VoiceChannel {
  join(roomId: string): Promise<void>;
  leave(): void;
  mute(): void;
  unmute(): void;
  onPeerJoined(cb: (peerId: string) => void): void;
  onPeerLeft(cb: (peerId: string) => void): void;
}
// 当前不实现，UI 上预留按钮（disabled 状态 + tooltip "即将上线"）
```

### 3.5 WebSocket 消息协议

所有消息统一 JSON 格式：

```json
{
  "type": "消息类型",
  "room": "房间号",
  "from": "发送者ID",
  "data": { }
}
```

消息清单：

| type | 方向 | 用途 | data |
|------|------|------|------|
| `room:create` | C→S | 创建房间 | `{ fileName, fileSize }` |
| `room:join` | C→S | 加入房间 | `{ roomCode }` |
| `room:joined` | S→C | 有人加入 | `{ userId, role }` |
| `room:left` | S→C | 有人离开 | `{ userId }` |
| `file:info` | C→S | 上报文件信息 | `{ name, size }` |
| `file:match` | S→C | 验证结果 | `{ matched, diff? }` |
| `sync:play` | C↔C | 播放 | `{ time, timestamp }` |
| `sync:pause` | C↔C | 暂停 | `{ time, timestamp }` |
| `sync:seek` | C↔C | 拖动进度 | `{ time, timestamp }` |
| `sync:rate` | C↔C | 倍速 | `{ rate, timestamp }` |
| `sync:heartbeat` | 双向 | 心跳/时间校准 | `{ clientTime }` |
| `chat:message` | C↔C | 聊天 | `{ text }` |
| `error` | S→C | 错误 | `{ code, message }` |

**传输通道规则**：`sync:*` 和 `chat:*` 在 P2P 建立后走 DataChannel（不经服务器）；P2P 未建立时由服务器转发。消息格式不变，仅通道不同。

### 3.6 房间生命周期

| 项 | 值 | 理由 |
|----|-----|------|
| 房间号格式 | 4 位数字（如 3847） | 手动输入方便 |
| 无人加入超时 | 2 小时 | 防僵尸房间 |
| 最大人数 | 2 人 | MVP 定位 |
| 断线重连窗口 | 30 秒 | 平衡误杀与资源 |
| 重连行为 | 同一 userId 30s 内重连 → 恢复原状态 | 无需重新选文件 |
| 双方离开 | 立即销毁 | — |
| 房主退出 | 提示"房主离开，30s 后关闭" | 给另一方缓冲 |
| 心跳间隔 | 5 秒 | 兼顾及时性和性能 |
| 判定掉线 | 连续 3 次心跳未收到（15s） | 避免抖动误判 |

状态机：

```
[等待中] → 对方加入 → [选文件中] → 双方验证通过 → [播放中]
                                                      ↓
                                              一方掉线 → [等待重连]
                                                      ↓ (30s超时)
                                                  [已关闭]
```

---

## 4. 技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 前端框架 | React 18 + TypeScript | — |
| 构建工具 | Vite | — |
| 样式 | TailwindCSS + animal-island-ui | 动森风格组件库 |
| 播放器 | ArtPlayer | 轻量、插件丰富、支持自定义控件 |
| 图标 | animal-island-ui Icon + Lucide Icons | 全部 SVG，禁用 emoji |
| 实时通信 | 原生 WebSocket | 信令 + 同步指令 |
| P2P | 原生 RTCPeerConnection / PeerJS | DataChannel 同步 |
| 后端 | Node.js + Fastify | 仅信令转发 + 房间管理 |
| WebSocket 库 | ws (Node.js) | 轻量 |
| 数据库 | 无（内存房间管理） | MVP 阶段无需持久化 |
| 部署 | Docker Compose | 一键部署 |
| 服务器 | 轻量应用服务器 2核2G | 信令流量极小，足够 |

---

## 5. UI/UX 规范

### 5.1 界面草图

布局参考见 `wireframe.html`（项目根目录），包含 6 个页面：首页、等待室、文件选择、播放器(桌面)、播放器(手机)、错误状态。草图仅定义功能布局，不代表最终视觉。

### 5.2 组件库

使用 [animal-island-ui](https://github.com/guokaigdg/animal-island-ui)（动森风格 React 组件库）。

**关键文档**（AI 开发时必读）：
- `AI_USAGE.md`：所有组件 props/类型/默认值/禁用用法
- `skill/SKILL.md`：像素级样式规范（色值、间距、动画）
- `DESIGN_PROMPT.md`：视觉提示词

**使用规则**：
```tsx
import { Button, Card, Modal, Icon, Notification } from 'animal-island-ui';
import 'animal-island-ui/style';  // 必须在入口文件最前面导入
```

### 5.3 图标规范

- **禁止使用 emoji 作为图标**
- 优先使用 animal-island-ui 内置 Icon（10 个 SVG 图标）
- 不够用时使用 Lucide Icons（800+ SVG），颜色统一为 `#794f27`（主文字棕色）
- 图标尺寸：16px（行内）/ 20px（按钮）/ 24px（导航）

### 5.4 配色（继承 animal-island-ui）

| 用途 | 色值 |
|------|------|
| 主色（薄荷青绿） | `#19c8b9` |
| 主文字（温暖棕） | `#794f27` |
| 正文 | `#725d42` |
| 背景（奶油米白） | `#f8f8f0` |
| 边框 | `#c4b89e` |

### 5.5 响应式断点

| 断点 | 宽度 | 适配 |
|------|------|------|
| mobile | < 640px | 手机竖屏 |
| tablet | 640-1024px | 平板/手机横屏 |
| desktop | > 1024px | 电脑 |

### 5.6 设计原则

- 圆润、温暖、低压迫感（动森风格）
- 操作步骤最少化（零注册、链接即入）
- 状态反馈即时可见（连接状态、同步状态、对方在线状态）

---

## 6. 异常处理

### 6.1 全景表

| 场景 | 用户提示 | 技术处理 |
|------|----------|----------|
| 文件格式不支持 | "该格式浏览器无法播放，建议使用 .mp4 / .webm / .mkv（Chrome）" | 白名单校验，选择时立即拦截 |
| 双方文件不一致 | "文件不匹配：你的文件 4.2GB，对方 4.1GB，请确认是同一版本" | 对比 name + size，展示具体差异 |
| P2P 连接失败 | "直连失败，当前网络不支持。请检查路由器 IPv6 设置，或稍后重试" | 超时 15s 报错，预留 TURN 入口 |
| IPv6 不可用 | "未检测到 IPv6，请确认网络支持（当前仅支持 IPv6 直连）" | ICE candidate 类型判断 |
| 解码漂移/不同步 | 静默校准；严重时："进度偏差较大，正在重新同步…" | 每 5s 交换时间戳，偏差 > 2s 自动 seek |
| 对方掉线 | "对方已断开，等待重新加入…（30s 后自动关闭房间）" | WebSocket heartbeat |
| 浏览器不兼容 | "浏览器版本过低，请使用 Chrome 90+ / Edge 90+ / Safari 15+" | 特性检测（WebSocket、createObjectURL、mediaDevices） |
| iOS 后台暂停 | "iOS 切出应用会暂停视频，请保持屏幕常亮" | UA 检测，进入房间时提示 |
| 文件读取失败 | "无法读取文件，请确认文件未损坏且未被占用" | createObjectURL 异常捕获 |
| WebSocket 断开 | "连接中断，正在重连…（第 N 次）" | 指数退避重连，最多 5 次 |
| 房间不存在/过期 | "房间已关闭或链接无效" | 服务端 TTL 管理 |
| 房间已满 | "房间已满（当前仅支持 2 人）" | 服务端拒绝第三连接 |

### 6.2 格式白名单

```
视频：.mp4, .webm, .mkv(仅Chrome/Edge), .m4v, .mov(Safari)
字幕：.srt, .vtt, .ass(需转换)
```

### 6.3 错误提示设计原则

1. **说人话**：不显示技术术语（如 "ICE candidate gathering failed"）
2. **说原因**：告诉用户为什么失败
3. **说方案**：告诉用户下一步怎么做
4. **分级**：可恢复 → Toast/Notification；不可恢复 → Modal 阻断

---

## 7. 开发规范

### 7.0 开发教训（踩过的坑，必读）

1. **跨页面消息消费问题**：WebSocket 消息被页面 A 消费后，导航到页面 B 时信息丢失（如角色 role）。解决：导航时用路由 state 传递关键状态，或用全局 store。
2. **服务端必须幂等**：同一用户重复 join 不能改变角色/人数/广播。任何“加入/创建”类接口都要防重。
3. **不要只修表面现象**：修 bug 前先把完整消息链路（谁发→谁收→什么时序）在纸面上走一遍，找到根因再动手。
4. **先写集成测试再声称修复**：服务端逻辑用 vitest + 真实 ws 客户端跑完整流程（server/test/），每次修 bug 必须加回归测试。
5. **验收标准要端到端**：“代码写完+编译通过”≠“功能可用”，必须双窗口实际走一遍用户流程才算完成。

### 7.1 结构化日志

```typescript
// 所有日志必须包含 module + action + state
logger.error({
  module: "webrtc-connection",
  action: "ice-candidate-gathering",
  state: connectionState,
  detail: { iceCandidates: candidates.length, ipv6Available: hasIPv6 },
  errorMessage: error.message,
  suggestion: "检查防火墙或路由器 IPv6 设置"
});
```

### 7.2 调试面板（仅开发模式）

内置浮动面板，显示：
- WebSocket 连接状态（connected/reconnecting/disconnected）
- WebRTC ICE 状态变化日志
- 同步时间偏差（ms）
- 最近 20 条结构化日志
- 房间信息（ID、人数、房主）

### 7.3 错误边界

```typescript
// 全局错误捕获
window.onerror → 开发环境显示调试面板 / 生产环境静默上报
React ErrorBoundary → 组件级崩溃兜底 UI
```

### 7.4 命名约定

- 组件：PascalCase（`RoomCard.tsx`）
- 工具函数：camelCase（`formatFileSize.ts`）
- 常量：UPPER_SNAKE（`MAX_FILE_SIZE`）
- CSS：TailwindCSS utility-first，自定义用 CSS Modules

---

## 8. 项目结构

```
SameMoon/
├── PLAN.md                    # 本文件
├── client/                    # 前端
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   └── src/
│       ├── main.tsx           # 入口（import 'animal-island-ui/style'）
│       ├── App.tsx
│       ├── components/        # UI 组件
│       │   ├── Room/          # 房间相关
│       │   ├── Player/        # 播放器相关
│       │   ├── Chat/          # 聊天
│       │   └── common/        # 通用组件
│       ├── hooks/             # 自定义 hooks
│       │   ├── useWebSocket.ts
│       │   ├── useWebRTC.ts
│       │   ├── usePlayerSync.ts
│       │   └── useFileSelect.ts
│       ├── services/          # 业务逻辑层
│       │   ├── transport/     # 连接策略（预留 TURN）
│       │   │   ├── TransportStrategy.ts    # 接口定义
│       │   │   ├── IPv6DirectTransport.ts
│       │   │   ├── StunTransport.ts
│       │   │   └── TurnTransport.ts        # 预留，暂空实现
│       │   ├── voice/         # 语音（预留）
│       │   │   └── VoiceChannel.ts         # 接口定义，暂空实现
│       │   ├── sync/          # 同步协议
│       │   │   └── SyncEngine.ts
│       │   └── room/          # 房间管理
│       │       └── RoomManager.ts
│       ├── utils/
│       │   ├── logger.ts      # 结构化日志
│       │   ├── fileValidator.ts
│       │   ├── formatFileSize.ts
│       │   └── browserDetect.ts
│       ├── types/             # TypeScript 类型定义
│       │   └── index.ts
│       └── styles/
│           └── globals.css
├── server/                    # 后端（信令服务器）
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── src/
│       ├── index.ts           # 入口
│       ├── routes/            # HTTP 路由（房间创建等）
│       ├── ws/                # WebSocket 处理
│       │   ├── handler.ts
│       │   └── protocol.ts   # 消息协议定义
│       ├── room/              # 房间管理
│       │   └── RoomManager.ts
│       └── types/
├── docker-compose.yml
└── .env.example
```

---

## 9. 开发计划

### Phase 1：基础骨架（MVP 核心闭环）

- [x] 初始化前端项目（React + Vite + TS + TailwindCSS + animal-island-ui）
- [x] 初始化后端项目（Node.js + Fastify + ws）
- [x] 实现房间创建/加入（链接分享模式）
- [ ] 实现本地文件选择 + 格式校验
- [ ] 实现文件一致性验证（name + size）（后端逻辑已完成并有测试覆盖，缺前端 UI）
- [ ] 实现基础播放器（ArtPlayer）
- [ ] 实现 WebSocket 同步播放（play/pause/seek）（后端转发已完成，缺前端）
- [ ] 基础错误处理 + 提示

**验收标准**：两台设备打开同一链接，选择同一文件，能同步播放/暂停/拖动进度。

### Phase 2：P2P 直连

- [ ] WebRTC DataChannel 建立（IPv6 + STUN）
- [ ] 同步指令迁移到 P2P（WebSocket 降级为备用）
- [ ] 连接状态检测 + 断线重连
- [ ] 解码漂移自动校准
- [ ] 连接失败完整报错流程

**验收标准**：两台 IPv6 设备能 P2P 直连同步，拔掉网线后重连恢复。

### Phase 3：体验完善

- [ ] 响应式 UI 适配（手机/平板/电脑）
- [ ] 文字聊天
- [ ] 弹幕模式（聊天消息可选以弹幕形式飘过视频画面，非核心功能，作为聊天的展示变体）
- [ ] 字幕加载
- [ ] 调试面板
- [ ] 完整异常处理覆盖
- [ ] PWA 支持（添加到主屏幕）

### Phase 4：扩展功能

- [ ] 语音通话（实现预留接口）
- [ ] TURN 兜底（实现预留接口）
- [ ] 播放历史
- [ ] 多人支持（架构扩展）

---

## 10. 部署方案

| 项 | 方案 |
|----|------|
| 服务器 | 轻量应用服务器 2核2G（起步足够） |
| 容器化 | Docker Compose（前端 Nginx + 后端 Node） |
| HTTPS | Let's Encrypt 免费证书 / Caddy 自动续签 |
| 域名 | 需购买（.app / .love / .moon 等） |
| STUN 服务器 | 自建 coturn 或使用公共 STUN（stun.l.google.com:19302） |
| 带宽需求 | 极低（仅 WebSocket 文本消息），轻量服务器绑绑有余 |

**何时需要升级**：若后续实现服务器中继直播模式（一路 1080p ≈ 4-8Mbps），需考虑云服务器按带宽计费。

---

## 11. 开源依赖清单

| 依赖 | 用途 | 许可 |
|------|------|------|
| [animal-island-ui](https://github.com/guokaigdg/animal-island-ui) | UI 组件库（动森风格） | CC BY-NC 4.0（非商用） |
| [Lucide Icons](https://lucide.dev) | SVG 图标补充 | ISC |
| [ArtPlayer](https://artplayer.org) | 视频播放器 | MIT |
| [PeerJS](https://peerjs.com)（可选） | WebRTC 封装 | MIT |
| [Fastify](https://fastify.dev) | 后端框架 | MIT |
| [ws](https://github.com/websockets/ws) | Node.js WebSocket | MIT |
| [TailwindCSS](https://tailwindcss.com) | 原子化 CSS | MIT |

**注意**：animal-island-ui 为 CC BY-NC 4.0，仅限非商用。若项目未来商业化需替换。

---

## 12. 已知限制与约束

| 限制 | 说明 | 应对 |
|------|------|------|
| .mkv 仅 Chrome/Edge 支持 | Safari/Firefox 无法播放 mkv | 提示用户用 Chrome 或转 mp4 |
| iOS Safari 后台暂停 | 切出页面视频停止 | PWA + 提示保持前台 |
| 无 TURN 约 15-30% 连接失败 | 取决于用户网络环境 | 明确报错 + 后续加 TURN |
| 大文件选择需等待 | 4GB+ 文件浏览器需几秒准备 | 显示 loading 状态 |
| 仅支持 2 人 | MVP 架构为双人设计 | 后续扩展需重构房间模型 |
| 文件必须完全一致 | 不同字幕组/版本无法同步 | 提示"请确保同一版本" |
| animal-island-ui 非商用许可 | CC BY-NC 4.0 | 商业化时需替换组件库 |

---

## 13. 安全与隐私

- **文件不经过服务器**：仅在用户本地播放，服务器无法获取文件内容
- **房间链接即权限**：知道链接 + 拥有同名文件 = 可加入（无额外鉴权）
- **WebSocket 走 WSS**：生产环境强制 HTTPS/WSS 加密
- **不存储任何用户数据**：MVP 阶段无数据库、无账号系统
- **房间自动销毁**：双方离开后 / TTL 到期后自动清理

---

## 14. 未来路线图

| 阶段 | 内容 |
|------|------|
| 近期 | TURN 兜底、语音通话、多人房间 |
| 中期 | 一起听歌、一起看书（同步翻页） |
| 远期 | 移动端原生 App（Tauri Mobile / React Native） |
| 远期 | 屏幕共享模式（一方直播屏幕给另一方） |
| 远期 | 账号系统、观影记录、好友列表 |

---

## 15. 待讨论方向

> 以下问题尚未深入探讨，开发到相关阶段时应先暂停、讨论确认后再继续。

| 话题 | 简述 | 何时需要 |
|------|------|----------|
| 时间同步算法 | 两设备时钟有偏差，需 NTP 式校准（交换多次 RTT 取中位数） | Phase 2 |
| STUN 服务器选择 | 公共（Google）vs 自建 coturn，稳定性与成本权衡 | Phase 2 |
| PWA 细节 | App 图标、名称、主题色、离线 fallback 页面 | Phase 3 |
| 测试策略 | P2P 如何自动化测试？不同网络环境如何模拟？ | Phase 2 起 |
| 法律/免责 | 用户同步版权内容的法律风险，是否需加免责声明 | 上线前 |
| 美学打磨 | 当前草图仅定义布局，最终视觉需结合动森风格细化 | Phase 3 |
| 多人扩展架构 | 若支持 >2 人，房间模型、同步策略需重新设计 | Phase 4 |
| 商业化路径 | animal-island-ui 非商用许可，商业化需替换组件库 | 远期 |

---

## 16. 给 AI 的开发提示

> 接手本项目时请注意：

1. **必读本文件**后再动手，不要自行发挥架构
2. **UI 组件**优先用 animal-island-ui，查阅其 `AI_USAGE.md` 获取 props 定义
3. **图标禁止用 emoji**，必须 SVG（animal-island-ui Icon / Lucide）
4. **日志必须结构化**（module + action + state + suggestion）
5. **错误提示说人话**（原因 + 方案），不暴露技术细节
6. **预留接口不可删除**：`TurnTransport`、`VoiceChannel` 即使空实现也要保留
7. 本地已安装 `me-animal-island-ui` skill，开发 UI 时会自动加载组件规范
