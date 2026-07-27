# 2026-07-28 Bug 修复 + Phase 1 Step 5 实施记录

> 本次对话完成：4 个 Bug 修复 + Step 5 完整实施（会话恢复、服务端加固、DebugPanel、ErrorBoundary）+ 3 个刷新/重连问题修复

---

## 第一部分：Bug 修复

### Bug 1：`sendState()` 错误递增 seq

**根因**：`sendState()` 调用 `captureState()`，后者每次都会 `this.seq += 1`。TECH-SPEC §1.5 规定 seq 仅在用户操作时递增。当一方请求 `sync:state` 时，响应方的 seq 被无意义膨胀，导致后续用户操作"不公平"地获得更高 seq。

**修复**：新增 `snapshotState()` 方法（不递增 seq），`sendState()` 改用快照。

**文件**：`client/src/services/sync/SyncEngine.ts`

```typescript
// 用户操作触发，递增 seq
private captureState(): PlaybackState { this.seq += 1; ... }

// 被动响应，不递增 seq
private snapshotState(): PlaybackState { ... /* 不加 this.seq += 1 */ }
```

**回归测试**：`client/test/SyncEngine.test.ts` 新增「sendState 不应递增 seq」场景。

---

### Bug 2：`syncStatus` UI 永远显示「已同步」

**根因**：`PlayerPage` 中 `const [syncStatus] = useState<'synced' | 'drifting' | 'buffering'>('synced')`，未析构 setter，状态永远不变。

**修复**：
1. `SyncEngine` 新增事件类型 `SyncEngineEvent = 'synced' | 'drifting' | 'buffering' | 'buffering-timeout'`
2. 漂移校正中档 → `onEvent('drifting')`，大档 → `onEvent('drifting')`，缓冲 → `onEvent('buffering')`，就绪 → `onEvent('synced')`
3. `PlayerPage` 通过 `onEvent` 回调实时更新 `syncStatus` 状态

**文件**：`client/src/services/sync/SyncEngine.ts`、`client/src/components/Player/PlayerPage.tsx`

---

### Bug 5：`useEffect` 依赖缺失

**根因**：`PlayerPage` 中 `useEffect` 内部调用 `startSync()`，但 `startSync` 不在依赖数组中。

**修复**：将 `startSync` 用 `useCallback` 包裹（依赖 `[userId, send]`），加入 `useEffect` 依赖数组。

**文件**：`client/src/components/Player/PlayerPage.tsx`

---

### Bug 8：PlayerPage 无对方重连处理

**根因**：对方断线重连后，`PlayerPage` 不处理 `room:peer-joined` 消息。

**修复**：收到 `room:peer-joined` 后停止旧引擎、重置状态、等待双方重新握手。

**文件**：`client/src/components/Player/PlayerPage.tsx`

---

## 第二部分：Phase 1 Step 5 实施

### 1. 服务端 sessionId 身份模型改造（TECH-SPEC §3）

**客户端**：
- `sessionStorage` 存储稳定 `sessionId`（`crypto.randomUUID()`），刷新不丢
- 连接后第一条消息发送 `session:hello { sessionId }`
- `WebSocketProvider` 新增 `restoredData` 状态，收到 `session:restored` 后填入

**服务端**：
- `RoomManager` 新增 `markOffline()`、`reconnectUser()`、`startDisconnectTimer()`、`forceRemove()` 等方法
- 断线 30s 倒计时，超时后真正移除用户
- 同 sessionId 重连 → 下发 `session:restored`（含房间状态、文件信息等）
- `findUserRoom()` 方法用于快速定位 sessionId 所在房间

**文件**：`client/src/hooks/useWebSocket.tsx`、`server/src/room/RoomManager.ts`、`server/src/app.ts`

**测试**：`server/test/RoomManager.test.ts` 新增 4 个场景（断线重连、超时移除、重连清除定时器、peerOnline 状态）

---

### 2. 服务端安全加固（TECH-SPEC §6，9 项全部实施）

| # | 加固项 | 数值/规则 | 文件 |
|---|--------|----------|------|
| 1 | 消息大小限制 | ≤ 4KB | `server/src/app.ts` |
| 2 | 消息频率限制 | 30 条 / 10s（滑动窗口） | `server/src/app.ts` |
| 3 | roomCode 正则校验 | `/^\d{4}$/` | `server/src/app.ts` |
| 4 | 聊天长度限制 | ≤ 500 字符 | `server/src/app.ts` |
| 5 | join 频率限制 | 每 IP 20 次/分钟 | `server/src/app.ts` |
| 6 | 房间总数上限 | ≤ 5000 | `server/src/room/RoomManager.ts` |
| 7 | 未 hello 断开 | 10s 内未发 `session:hello` → close(1002) | `server/src/app.ts` |
| 8 | JSON 格式校验 | 必须是 object，type 必须 string | `server/src/app.ts` |
| 9 | 转发消息白名单 | `FORWARD_WHITELIST` Set，非白名单拒绝 | `server/src/app.ts` |

**测试**：`server/test/integration.test.ts` 新增 3 个加固测试（无效 roomCode 拒绝、未 hello 拒绝、超大消息拒绝）

---

### 3. ErrorBoundary + DebugPanel

**ErrorBoundary**：全局 React 错误边界，捕获异常后展示「页面遇到意外错误」+ 错误信息 + 「重试」和「返回首页」按钮。

**DebugPanel**：右下角 🐛 图标，点击展开浮窗，显示 WS 状态、User ID、重连次数、最近 20 条日志。

**文件**：`client/src/components/common/ErrorBoundary.tsx`、`client/src/components/common/DebugPanel.tsx`、`client/src/App.tsx`

---

## 第三部分：刷新/重连问题修复（3 个联动修复）

### 问题 1：刷新后进入播放器报错 `usingClientEntryPoint`

**根因**：PlayerPage 检测到文件丢失后立即 `navigate()`，同时 WS 收到 `session:restored` 触发状态更新，两个 React 操作竞态导致 fiber 非法访问。

**修复**：
- `PlayerPage`：无文件时改为 `missing-file` 阶段展示友好提示卡片，不再立即 navigate
- `RoomPage`：`restoredData` 激活时用 `restoredActiveRef` 跳过 auto-join，防止双消息竞态
- `HomePage`：收到 `session:restored` 后自动跳转到房间页

---

### 问题 2：返回首页后创建房间按钮无反应

**根因**：用户未离开房间就返回首页，WS 连接未断，服务端仍保留 `currentRoom`，创建房间返回 `ALREADY_IN_ROOM`——但之前无任何提示。

**修复**：
- `HomePage`：`ALREADY_IN_ROOM` 错误显示「你还在之前的房间里」+ 引导用户重置连接
- `HomePage`：非 connected 状态也给反馈「正在连接服务器…」

---

### 问题 3：刷新后重选文件仍报错（死循环）

**根因**：服务端重连后保留了旧的 `fileInfo`，双方仍"已匹配"状态，但客户端 objectURL 已失效。

**修复（3 层联动）**：

| 层 | 改动 |
|----|------|
| **服务端** | 重连时清除该用户 `fileInfo`，房间状态从 `playing` 退回 `selecting`，向对方广播 `file:reset` |
| **RoomPage** | 重连后在文件区顶部显示蓝色横幅「已恢复房间，请重新选择文件：xxx.mp4 (4.2GB)」；收到 `file:reset` 自动重置匹配；新增「离开房间」按钮 |
| **HomePage** | 新增「重置连接（清除旧会话）」按钮，卡死时一键清空 sessionStorage 重新开始 |

---

## 测试结果

| 测试集 | 数量 | 状态 |
|--------|------|------|
| `client/test/SyncEngine.test.ts` | 8 个（含 1 个回归测试） | ✅ 全部通过 |
| `server/test/RoomManager.test.ts` | 11 个（含 4 个新场景） | ✅ 全部通过 |
| `server/test/sync.test.ts` | 5 个 | ✅ 全部通过 |
| `server/test/integration.test.ts` | 8 个（含 3 个加固测试） | ✅ 全部通过 |
| TypeScript 编译检查 | client + server | ✅ 零错误 |
| **总计** | **32 个** | **✅ 全部通过** |

---

## NEO_PLAN.md 复选框更新

```
- [x] Step 1 前后端初始化
- [x] Step 2 房间系统
- [x] Step 3 文件选择 + 验证 UI
- [x] Step 4 播放器 + 同步引擎
- [x] Step 5 会话恢复 + 错误处理收尾
```

---

## 变更文件清单

### 客户端（8 个文件）

| 文件 | 操作 | 说明 |
|------|------|------|
| `client/src/services/sync/SyncEngine.ts` | 修改 | Bug 1: snapshotState + 事件系统扩展 |
| `client/src/components/Player/PlayerPage.tsx` | 修改 | Bug 2/5/8: syncStatus 动态更新 + missing-file 阶段 + 依赖修复 |
| `client/src/hooks/useWebSocket.tsx` | 修改 | Step 5: sessionId + restoredData + session:hello |
| `client/src/components/Room/HomePage.tsx` | 重写 | session:restored 自动跳转 + ALREADY_IN_ROOM 提示 + 重置连接 |
| `client/src/components/Room/RoomPage.tsx` | 重写 | restoredData 恢复 + file:reset 处理 + 蓝色横幅 + 离开房间 |
| `client/src/components/common/ErrorBoundary.tsx` | 新建 | 全局错误边界 |
| `client/src/components/common/DebugPanel.tsx` | 新建 | 调试面板（WS 状态/日志） |
| `client/src/App.tsx` | 修改 | 集成 ErrorBoundary + DebugPanel |
| `client/test/SyncEngine.test.ts` | 修改 | Bug 1 回归测试 |
| `client/test/fakes.ts` | 未改 | — |

### 服务端（4 个文件）

| 文件 | 操作 | 说明 |
|------|------|------|
| `server/src/room/RoomManager.ts` | 重写 | 断线标记/重连/倒计时/peerOnline/fileInfo 管理 |
| `server/src/app.ts` | 重写 | session:hello 流程 + 9 项安全加固 + fileInfo 清除 |
| `server/src/ws/protocol.ts` | 修改 | 新增 SessionHelloMsg / SessionRestoredMsg 类型 |
| `server/test/RoomManager.test.ts` | 重写 | 新增 4 个断线重连场景 |
| `server/test/integration.test.ts` | 重写 | 新增 3 个加固测试 |
| `server/test/sync.test.ts` | 重写 | 适配 session:hello 流程 |

### 文档（1 个文件）

| 文件 | 操作 | 说明 |
|------|------|------|
| `docs/NEO_PLAN.md` | 修改 | Step 3/4/5 复选框更新 + 协议表更新 |

---

## 后续待办（Phase 2+）

- [ ] Phase 2：WebRTC P2P 直连（rtc 信令 + DataChannel）
- [ ] Phase 3：在线视频模式（DirectUrlAdapter + YouTubeAdapter）
- [ ] Phase 4：文字聊天 + 弹幕 + 字幕 + 倒计时 + 响应式打磨 + PWA
- [ ] Phase 5：语音通话 + TURN 兜底
- [ ] Playwright E2E 双 browser context 测试
- [ ] GitHub Actions CI
