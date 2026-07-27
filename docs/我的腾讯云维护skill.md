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
docker compose -f <path> up -d    # 启动服务
docker compose -f <path> down     # 停止服务
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

- 部署/更新：`cd ~/app-configs/<项目> && git pull && docker compose up -d`
- 备份：`tar -czf backup-$(date +%F).tar.gz ~/app-configs/`
- `.env` 绝不进 GitHub，只在服务器上

## 当前已部署服务

| 端口 | 项目 | 容器 | 配置目录 |
|------|------|------|----------|
| 3000 | SameMoon | sm-client / sm-server | `~/app-configs/same-moon/` |

## 迁移流程（换新服务器时）

1. 新服务器选 Ubuntu 24.04 + Docker 预装镜像
2. 本地配置 SSH 免密（`ssh-copy-id`）
3. 服务器上：`git clone` 部署仓库
4. 手动补 `.env` 文件
5. `docker compose up -d`
6. 验证服务正常

## 注意事项

- 禁止在宿主机直接 `npm install` / `pip install`，一切走 Docker
- 2G 内存有限，避免在服务器上构建（build），用 GitHub Actions 或本地构建后推镜像
- 腾讯云控制台“防火墙”需开放服务端口（默认只开了 22）
- 服务器是试用性质，重要数据必须备份到 GitHub 或本地

## SameMoon 部署与更新

### 首次部署（新服务器）

```bash
# 1. 克隆配置仓库
ssh SM
git clone https://github.com/RayMorTwinkle/ServerX.git ~/app-configs

# 2. 本地构建前端（在本地机器执行，不在服务器 build）
exit
cd /path/to/SameMoon/client && npm run build

# 3. 上传前端构建产物到服务器
scp -r dist/* SM:~/app-configs/same-moon/client/dist/

# 4. 服务器启动
ssh SM
cd ~/app-configs/same-moon
bash setup.sh

# 5. 验证
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/  # 应返回 200
```

> ⚠️ 首次启动会自动下载 Docker 镜像（node:alpine + nginx:alpine）和 npm install，耗时约 1-2 分钟。

### 后续更新（代码迭代后）

**只改前端代码时**（最常见）：

```bash
# 本地构建
cd /path/to/SameMoon/client && npm run build

# 上传 + 重启前端容器
scp -r dist/* SM:~/app-configs/same-moon/client/dist/
ssh SM "sudo docker compose -f ~/app-configs/same-moon/docker-compose.yml restart sm-client"
```

**后端代码也改了时**：

```bash
# 1. 更新后端源码到服务器
cd ~/app-configs/same-moon
cp -r /path/to/SameMoon/server ./

# 2. 全量重建 + 重启
sudo docker compose up -d --build
```

**配置仓库（ServerX）更新时**：

```bash
cd ~/app-configs && git pull
cd same-moon && sudo docker compose up -d --build
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