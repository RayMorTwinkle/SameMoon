#!/bin/bash
set -e
echo "🚀 部署 SameMoon 到服务器..."

SERVER="root@150.158.149.24"
REMOTE_DIR="~/app-configs/same-moon"

echo "1/3 推送代码..."
git push

echo "2/3 SSH 到服务器拉取并重建..."
ssh "$SERVER" << EOF
  mkdir -p $REMOTE_DIR
  cd $REMOTE_DIR
  if [ -d .git ]; then
    git pull
  else
    git clone https://github.com/RayMorTwinkle/SameMoon.git .
  fi
  cp -f .env.example .env 2>/dev/null || true
  docker compose up -d --build
  echo "3/3 等待服务启动..."
  sleep 3
  docker compose logs --tail 10
EOF

echo "✅ 部署完成: http://150.158.149.24:4000"
