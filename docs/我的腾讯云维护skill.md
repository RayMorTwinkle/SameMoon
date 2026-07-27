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