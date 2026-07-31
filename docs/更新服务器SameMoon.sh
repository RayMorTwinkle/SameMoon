#!/usr/bin/env bash
# 更新服务器 SameMoon
# 用法：在 SameMoon 项目根目录执行 bash docs/更新服务器SameMoon.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="SM"
REMOTE_DIR="~/app-configs/same-moon"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── 1. 本地构建前端 ───────────────────────────────────
log "1/4 本地构建前端..."
cd "$PROJECT_DIR/client"
npm run build
DIST_SIZE=$(du -sh "$PROJECT_DIR/client/dist" | cut -f1)
log "✅ 前端构建成功（${DIST_SIZE}）"

# ── 2. 同步服务端源码到 ServerX 并上传 ─────────────────
log "2/4 同步服务端源码和配置到服务器..."
# 从 SameMoon 复制服务端源码到 ServerX（本地）
rsync -avz --delete --exclude='node_modules' --exclude='dist' --exclude='.env' --exclude='.env.example' \
  "$PROJECT_DIR/server/src/" "/Users/ray/Downloads/ServerX/same-moon/server/src/"
cp "$PROJECT_DIR/server/package.json" "/Users/ray/Downloads/ServerX/same-moon/server/"
cp "$PROJECT_DIR/server/tsconfig.json" "/Users/ray/Downloads/ServerX/same-moon/server/"
# 上传 ServerX 到服务器（排除 client/dist，后面单传）
rsync -avz --delete --exclude='.git' --exclude='node_modules' --exclude='.env' --exclude='client/dist/' \
  /Users/ray/Downloads/ServerX/same-moon/ "$SERVER:$REMOTE_DIR/"
log "✅ 服务端配置已同步"

# ── 3. 上传前端构建产物 ───────────────────────────────
log "3/4 上传前端 dist 到服务器..."
ssh "$SERVER" "mkdir -p $REMOTE_DIR/client/dist"
rsync -avz --delete "$PROJECT_DIR/client/dist/" "$SERVER:$REMOTE_DIR/client/dist/"
log "✅ dist 上传完成"

# ── 4. 重启服务 ───────────────────────────────────────
log "4/4 重启容器..."
ssh "$SERVER" "cd $REMOTE_DIR && sudo docker compose up -d --build sm-server && sudo docker compose restart sm-client"
log "✅ 容器已重启"

# ── 验证 ─────────────────────────────────────────────
sleep 2
STATUS=$(ssh "$SERVER" "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/" 2>/dev/null || echo "000")
if [ "$STATUS" = "200" ]; then
  log "✅ 部署完成！访问: http://150.158.149.24:3000"
else
  log "⚠️  HTTP 状态: $STATUS（nginx 可能尚未就绪，稍等重试）"
  log "查看日志: ssh $SERVER 'cd $REMOTE_DIR && sudo docker compose logs --tail 20'"
fi
