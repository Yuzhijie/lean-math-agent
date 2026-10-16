# 邀请制内测部署指南

适用于一台服务器上的邀请制小范围内测（文档第 7e 节的最低要求）。公开上线前还需完成 7e 里其余各项。

## 这次做好的保护

| 风险 | 现在的做法 |
| --- | --- |
| 匿名访问 | 生产模式下所有页面和接口都要登录；未登录访问页面会跳到登录页，访问接口返回 401。不再有共享的 `local` 用户 |
| 陌生人注册 | 只有邀请名单里的邮箱能登录（`INVITE_EMAILS`、`INVITE_DOMAINS`、`/app/data/invites.txt`）；没配名单时谁都登录不了 |
| 费用失控 | 所有调用模型的接口都计入用户当天的费用，并按次限流；每次模型调用实时记账，当天额度用完后新的调用被拒绝 |
| 费用算不出 | 任何在用模型缺少 `LLM_PRICES` 价格时，服务拒绝启动 |
| 证明不可用 | 镜像内含 Lean 4、编译好的 Mathlib 和 REPL |
| 数据库没表 | 容器启动时自动建表（`scripts/migrate.mjs`） |
| 端口外露 | 只有 nginx 对外（80 跳转 + 443）；应用、计算服务、Neo4j 只在内网 |
| 进度卡住 | nginx 对 `/api/` 关闭缓冲、超时 30 分钟，实时进度和关页面取消都能用 |
| 数据丢失 | `scripts/backup.sh` 在运行中做一致的快照 |

## 服务器

- Linux，Docker 与 Docker Compose v2
- 内存 ≥ 16 GB（每个 Lean 进程加载 Mathlib 约 1.5–2 GB），4 核，磁盘 ≥ 40 GB（镜像约 6–7 GB）
- 一个域名，A 记录指向服务器

## 步骤

1. **证书**（nginx 启动前）：
   ```bash
   sudo certbot certonly --standalone -d math.example.com
   mkdir -p certs && sudo cp /etc/letsencrypt/live/math.example.com/{fullchain,privkey}.pem certs/
   ```
2. **登录应用**：在 GitHub（Settings → Developer settings → OAuth Apps）或 Google Cloud 建 OAuth 应用，回调地址 `https://math.example.com/api/auth/callback/github`（或 `/google`）。
3. **配置**：`cp .env.production.example .env.production`，填 `NEXTAUTH_URL`、`NEXTAUTH_SECRET`（`openssl rand -base64 32`）、OAuth、`LLM_*`、`LLM_PRICES`、邀请名单和额度。
4. **启动**：`docker compose up -d --build`（首次构建 10–20 分钟）。
5. **检查**：`curl https://math.example.com/api/health` 应返回 `"ok": true`。若服务没起来，`docker compose logs web` 里 `[startup]` 开头的行会写明缺了什么。
6. **邀请**：名单里的人用对应邮箱的 GitHub/Google 账号登录。随时加人，不用重启：
   ```bash
   docker compose exec web sh -c 'echo teacher@school.org >> /app/data/invites.txt'
   ```
7. **备份**：每天自动备份，并把 `backups/` 同步到别处。
   ```bash
   0 3 * * * cd /srv/lean-math-agent && sh scripts/backup.sh && find backups -mtime +14 -delete
   ```

## 内测期间要盯的

- **费用**：模型供应商后台的日用量；单个用户可在 `/api/quota` 看当天花费。
- **日志**：`docker compose logs -f web`。
- **容量**：同时求解数 = `SOLVE_CONCURRENCY`，其余排队；内存不够时先降 `LEAN_REPL_WORKERS`。

## 还没做（公开上线前要补）

Lean 进程独立容器隔离、多实例（队列和限流在进程内存里）、错误监控（Sentry）、支付全流程实测、CI 里带 Lean 的冒烟测试、隐私政策与条款、计算服务换多线程服务器。
