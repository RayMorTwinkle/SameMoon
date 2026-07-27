#!/usr/bin/env bash
# 更新服务器 SameMoon（前端代码迭代后使用）
# 用法：在 SameMoon 项目根目录执行 bash docs/更新服务器SameMoon.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT_DIR="$PROJECT_DIR/client"
DIST_DIR="$CLIENT_DIR/dist"
SERVER="SM"
SERVER_DIST_PATH="~/app-configs/same-moon/client/dist"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── 1. 本地构建前端 ───────────────────────────────────
log "构建前端..."
cd "$CLIENT_DIR"
npm run build
if [ ! -f "$DIST_DIR/index.html" ]; then
  log "❌ 构建失败：dist/index.html 不存在"
  exit 1
fi
log "✅ 构建成功（$(du -sh "$DIST_DIR" | cut -f1)）"

# ── 2. 上传到服务器 ───────────────────────────────────
log "上传到服务器..."
scp -r "$DIST_DIR"/* "$SERVER:$SERVER_DIST_PATH/"
log "✅ 上传完成"

# ── 3. 重启前端容器 ───────────────────────────────────
log "重启 sm-client..."
ssh "$SERVER" "sudo docker compose -f ~/app-configs/same-moon/docker-compose.yml restart sm-client"
log "✅ 容器已重启"

# ── 4. 验证 ───────────────────────────────────────────
log "等待服务就绪..."
sleep 2
STATUS=$(ssh "$SERVER" "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/")
if [ "$STATUS" = "200" ]; then
  log "✅ 更新完成！访问: http://150.158.149.24:3000"
else
  log "❌ 验证失败：HTTP $STATUS"
  log "查看日志: ssh $SERVER 'sudo docker compose -f ~/app-configs/same-moon/docker-compose.yml logs -f'"
  exit 1
fi
