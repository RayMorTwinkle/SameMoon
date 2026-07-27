# Role: 腾讯云轻量服务器维护助手

## 服务器基本信息

| 项 | 值 |
|----|-----|
| 连接方式 | `ssh SM`（已配置免密） |
| IP | 150.158.149.24 |
| 用户 | ubuntu（需要 root 权限时 `sudo -i`） |
| 密码 | Ubuntu24.04（仅应急用，正常走密钥） |
| 系统 | Ubuntu 24.04 LTS |
| 配置 | 2核 2G |
| Docker | 29.6.1（预装，腾讯云镜像源） |
| Docker Compose | v5.3.1 |
| 监控工具 | btop |
| 性质 | 试用 1 个月，随时可能迁移 |

## 日常维护命令

```bash
# 连接
ssh SM

# 系统监控
btop                          # 交互式面板
free -h                       # 内存
df -h                         # 磁盘

# Docker 操作
docker ps                     # 查看运行中的容器
docker compose up -d          # 启动服务
docker compose down           # 停止服务
docker system prune -f        # 清理无用镜像/容器（释放磁盘）
docker logs <容器名> --tail 50    # 查看日志

# 重启 Docker（修改 daemon.json 后）
sudo systemctl restart docker

# 系统更新（谨慎，不要随意 upgrade 全部）
sudo apt update
sudo apt install <包名>
```

## 配置管理（三端同步）

```
GitHub 仓库（权威源，不含 secrets）
  ├── ServerX: https://github.com/RayMorTwinkle/ServerX (部署配置)
  └── SameMoon: https://github.com/RayMorTwinkle/SameMoon (源码)
     │  git pull
     ▼
服务器 ~/app-configs/<项目名>/（运行态，含 .env）
     │  backup.sh
     ▼
GitHub backup 分支 或 本地电脑
```

- 部署/更新：`cd ~/app-configs/<项目> && bash setup.sh`
- 备份：`tar -czf backup-$(date +%F).tar.gz ~/app-configs/`
- `.env` 绝不进 GitHub，只在服务器上
- 部署配置在 ServerX 仓库，源码在 SameMoon 仓库

## SameMoon 架构

```
浏览器 :3000 → nginx (sm-client)
                ├── /          → 静态文件 (client/dist)
                ├── /ws        → proxy → sm-server:4000 (WebSocket)
                ├── /api/*     → proxy → sm-server:4000
                └── /health    → proxy → sm-server:4000
```

## 当前已部署服务

| 端口 | 项目 | 容器 | 配置目录 |
|------|------|------|----------|
| 3000 | SameMoon | sm-client (nginx) / sm-server (node) | `~/app-configs/same-moon/` |

## SameMoon 部署与更新

### 首次部署

```bash
# 1. 服务器 clone ServerX 配置仓库
ssh SM
git clone https://github.com/RayMorTwinkle/ServerX.git ~/app-configs
cp -r ~/app-configs/same-moon ~/app-configs/same-moon

# 2. 创建 .env（TURN 凭据，不进 Git）
cd ~/app-configs/same-moon
cat > .env << 'EOF'
TURN_KEY_ID=73ea334142af06b9d8f835e31d0fc1f4
TURN_API_TOKEN=3674f6a26801b3b524aba83575662ce9673dc8a8f07b3267635021bd3c95e2df
EOF

# 3. 本地构建前端 + 上传（在本地机器执行）
exit
cd /path/to/SameMoon/client && npm run build
rsync -avz dist/ SM:~/app-configs/same-moon/client/dist/

# 4. 启动服务（Docker 内构建服务端，不污染宿主机）
ssh SM
cd ~/app-configs/same-moon
bash setup.sh
```

### 后续更新（一键脚本）

```bash
cd /path/to/SameMoon
bash docs/更新服务器SameMoon.sh
```

### 手动更新

```bash
# 1. 本地构建前端
cd client && npm run build

# 2. 上传 dist
rsync -avz dist/ SM:~/app-configs/same-moon/client/dist/

# 3. 更新后端源码（从 SameMoon 复制到 ServerX 本地，再上传）
rsync -avz --delete --exclude='node_modules' --exclude='.env' \
  server/src/ /path/to/ServerX/same-moon/server/src/
cp server/package.json /path/to/ServerX/same-moon/server/
rsync -avz --delete /path/to/ServerX/same-moon/ SM:~/app-configs/same-moon/

# 4. 重启
ssh SM "cd ~/app-configs/same-moon && sudo docker compose up -d --build sm-server"
ssh SM "cd ~/app-configs/same-moon && sudo docker compose restart sm-client"
```

### 常用运维命令

```bash
# 查看日志
sudo docker compose -f ~/app-configs/same-moon/docker-compose.yml logs -f

# 查看容器状态
sudo docker compose -f ~/app-configs/same-moon/docker-compose.yml ps

# 停止服务
sudo docker compose -f ~/app-configs/same-moon/docker-compose.yml down

# 重启服务
sudo docker compose -f ~/app-configs/same-moon/docker-compose.yml restart
```

## 迁移流程（换新服务器时）

1. 新服务器选 Ubuntu 24.04 + Docker 预装镜像
2. 本地配置 SSH 免密（`ssh-copy-id`）
3. 服务器上：`git clone https://github.com/RayMorTwinkle/ServerX.git ~/app-configs`
4. 手动补 `.env` 文件 + 上传前端 dist
5. `bash setup.sh`
6. 验证服务正常

## 注意事项

- **禁止在宿主机直接 `npm install` / `pip install`**，一切走 Docker
- **Docker 内部构建（`docker compose build`）是允许的**，它不污染宿主机环境。服务端 TypeScript 编译量小（秒级），在 Docker 内执行无压力
- 对于大型前端项目，前端 build 在本地执行后上传 dist（避免在 2G 服务器上跑 webpack/vite）
- 腾讯云控制台「防火墙」需开放服务端口（默认只开了 22 和 3000）
- 服务器是试用性质，重要数据必须备份到 GitHub 或本地
