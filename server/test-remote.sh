#!/usr/bin/env bash
# 服务器端自动化测试（Step 1 验证）
# 通过 Docker 容器内 Node.js 执行，测试对象是同一 Docker 网络的 sm-server:4000
# 用法：ssh SM "bash ~/app-configs/same-moon/test-remote.sh"
set -euo pipefail

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "=== HTTP 端点测试 ==="

# 测试 /health
HEALTH=$(curl -s http://localhost:3000/health)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  log "✅ 健康检查: $HEALTH"
else
  log "❌ 健康检查失败: $HEALTH"
fi

# 测试 /api/ice-servers
ICE=$(curl -s http://localhost:3000/api/ice-servers)
if echo "$ICE" | grep -q 'iceServers'; then
  log "✅ ICE servers 返回 iceServers 数组"
else
  log "❌ ICE servers 失败: $ICE"
fi
if echo "$ICE" | grep -q 'stun:'; then
  log "✅ 包含 STUN 服务器"
fi

# 前端页面 200
FRONT=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/)
if [ "$FRONT" = "200" ]; then
  log "✅ 前端返回 200"
else
  log "❌ 前端返回 $FRONT"
fi

# SPA fallback
FALLBACK=$(curl -s http://localhost:3000/room/1234 | head -c 15)
if echo "$FALLBACK" | grep -q '<!doctype html>'; then
  log "✅ SPA fallback 正常"
else
  log "❌ SPA fallback 失败: $FALLBACK"
fi

log ""
log "=== WebSocket 协议测试（docker exec） ==="

# 安装 ws 到 /tmp（一次性，复用）
sudo docker exec sm-server sh -c 'ls /tmp/node_modules/ws/index.js 2>/dev/null || npm install --prefix /tmp ws' 2>/dev/null

# 运行 WS 测试（容器内 localhost:4000，直连后端，不走 nginx）
sudo docker exec sm-server node --input-type=module -e '
import WebSocket from "/tmp/node_modules/ws/index.js";
import { randomUUID } from "node:crypto";

function waitFor(ws, timeout=3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout);
    ws.once("message", (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
  });
}

async function test() {
  let pass = 0, fail = 0;
  function ok(desc, cond) {
    if (cond) { console.log("✅ " + desc); pass++; }
    else { console.log("❌ " + desc); fail++; }
  }

  function connect(id) {
    return new Promise((resolve) => {
      const ws = new WebSocket("ws://localhost:4000/ws");
      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "session:hello", data: { sessionId: id } }));
        ws.once("message", () => resolve(ws));
      });
    });
  }

  // ── 默认 local-sync ──
  const ws = await connect(randomUUID());
  ws.send(JSON.stringify({ type: "room:create", data: {} }));
  const created = await waitFor(ws);
  ok("默认 mode=local-sync", created.data.mode === "local-sync");
  ok("含 roomCode(4位)", /^\d{4}$/.test(created.data.roomCode));
  ws.close();

  // ── file-transfer ──
  const ws2 = await connect(randomUUID());
  ws2.send(JSON.stringify({ type: "room:create", data: { mode: "file-transfer" } }));
  const c2 = await waitFor(ws2);
  ok("file-transfer 模式", c2.data.mode === "file-transfer");

  // ── screen-share ──
  const s3 = randomUUID();
  const ws3 = await connect(s3);
  ws3.send(JSON.stringify({ type: "room:create", data: { mode: "screen-share" } }));
  const c3 = await waitFor(ws3);
  const code3 = c3.data.roomCode;
  ok("screen-share 模式", c3.data.mode === "screen-share");

  // ── 加入时带 mode ──
  const s5 = randomUUID();
  const ws5 = await connect(s5);
  ws5.send(JSON.stringify({ type: "room:join", data: { roomCode: code3 } }));
  const joined = await waitFor(ws5);
  ok("room:joined mode=screen-share", joined.data.mode === "screen-share");

  // 排空 ws3 的 room:peer-joined（加入时自动广播）
  const peerJoined = await waitFor(ws3);
  ok("ws3 收到 peer-joined", peerJoined.type === "room:peer-joined");

  // ws5 先请求 → 获得 grant（成为分享者）
  ws5.send(JSON.stringify({ type: "screen:request", data: {} }));
  const grant5 = await waitFor(ws5);
  ok("ws5 screen:request → grant", grant5.type === "screen:grant");

  // ws3 后请求 → 被拒绝（ws5 已在分享）
  ws3.send(JSON.stringify({ type: "screen:request", data: {} }));
  const busy3 = await waitFor(ws3);
  ok("ws3 screen:request → busy", busy3.type === "screen:busy" && busy3.data.sharer === s5);

  // ws5 停止 → ws3 收到通知
  ws5.send(JSON.stringify({ type: "screen:stop", data: {} }));
  const stop = await waitFor(ws3);
  ok("screen:stop 通知对方", stop.type === "screen:stop");

  // ── RTC 转发 ──
  ws3.send(JSON.stringify({ type: "rtc:offer", data: { sdp: "v=0" } }));
  const offer = await waitFor(ws5);
  ok("rtc:offer 转发", offer.data.sdp === "v=0");

  ws5.send(JSON.stringify({ type: "rtc:answer", data: { sdp: "v=0-a" } }));
  const answer = await waitFor(ws3);
  ok("rtc:answer 回传", answer.data.sdp === "v=0-a");

  ws3.send(JSON.stringify({ type: "rtc:ice", data: { candidate: "candidate:1 udp host" } }));
  const ice = await waitFor(ws5);
  ok("rtc:ice 转发", ice.data.candidate.includes("udp host"));

  // ── file 消息转发 ──
  ws3.send(JSON.stringify({ type: "file:offer", data: { name: "test.mp4", size: 9999, type: "video/mp4" } }));
  const foff = await waitFor(ws5);
  ok("file:offer 转发", foff.data.name === "test.mp4");

  ws3.send(JSON.stringify({ type: "file:progress", data: { transferred: 100, total: 9999 } }));
  const fprog = await waitFor(ws5);
  ok("file:progress 转发", fprog.data.transferred === 100);

  ws3.send(JSON.stringify({ type: "file:complete", data: {} }));
  const fcomp = await waitFor(ws5);
  ok("file:complete 转发", fcomp.type === "file:complete");

  ws2.close(); ws3.close(); ws5.close();

  console.log("\n📊 Result: " + pass + " passed, " + fail + " failed");
  process.exit(fail > 0 ? 1 : 0);
}

test().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
'

log ""
log "📊 测试完成"
