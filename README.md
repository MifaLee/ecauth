# ecauth — EC 统一认证与授权平台

基于 EC OAuth2 SSO 的统一身份认证与多项目授权中心，支持 EC 企业账号一键登录、用户审批、功能级权限管理，以及多个子项目的统一纳管。

---

## 功能特性

- **EC SSO 单点登录** — 基于 EC 开放平台 OAuth2 Authorization Code 流程
- **本地用户注册与审批** — 支持管理员审批流，未审批用户不可进入子项目
- **功能级授权管理** — 按 `projectKey + featureKey` 粒度为用户授权
- **子项目令牌签发** — 登录成功后向子项目签发范围访问令牌
- **独立管理后台** — `/ecauth/admin` 提供用户管理、批量授权、项目注册
- **可复用 SDK** — 提供 Express 中间件与客户端工具，子项目快速接入
- **脚手架命令** — 一键生成子项目模板

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 运行时 | Node.js 20+ |
| 框架 | Express + TypeScript |
| 数据库 | PostgreSQL 14+ |
| 构建 | esbuild |
| 进程管理 | PM2 |
| 反向代理 | Nginx |

---

## 快速开始

### 前置要求

- Node.js 20+
- PostgreSQL 14+
- PM2（`npm install -g pm2`）
- Nginx
- EC 开放平台应用（需要 `client_id` 和 `client_secret`）

### 1. 克隆并安装依赖

```bash
git clone https://github.com/your-org/ecauth.git
cd ecauth
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，至少填写以下参数：

```env
PORT=3008
APP_BASE_PATH=/ecauth

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ecauth
DATABASE_SSL=false

SESSION_SECRET=change_me_to_a_long_random_secret
PROJECT_TOKEN_SECRET=change_me_to_a_long_random_secret
COOKIE_SECURE=false
SESSION_TTL_HOURS=12

PLATFORM_ADMIN_IDENTIFIERS=admin@example.com
ALLOWED_RETURN_TO_ORIGINS=http://localhost:3010,https://crm.example.com

EC_CLIENT_ID=your_client_id
EC_CLIENT_SECRET=your_client_secret
EC_AUTHORIZE_URL=https://iwx.workec.com/connect/oauth2/authorize
EC_TOKEN_URL=https://iwx.workec.com/connect/oauth2/token
EC_USERINFO_URL=https://iwx.workec.com/connect/oauth2/get_user_info
EC_REDIRECT_URI=https://your-domain.example.com/ecauth/auth/callback
```

### 3. 初始化数据库

```bash
npm run db:init
```

初始化后将创建以下核心表：`users`、`ec_identities`、`projects`、`features`、`user_feature_grants`、`audit_logs`。

### 4. 构建并启动

```bash
npm run build
pm2 start dist/server.js --name ecauth
pm2 save
```

### 5. 健康检查

```bash
curl http://127.0.0.1:3008/ecauth/health
# 预期: {"status":"ok","service":"ecauth","version":"2.0.0"}
```

---

## EC 开放平台配置

在 [iwx.workec.com](https://iwx.workec.com) 创建 OAuth2 应用后，将授权回调地址配置为：

```
https://your-domain.example.com/ecauth/auth/callback
```

> 回调地址必须与 `.env` 中的 `EC_REDIRECT_URI` **精确一致**（包括协议、路径、有无尾部斜杠），否则 EC 会返回 `server_error`。

EC OAuth2 端点一览：

| 端点 | URL |
|------|-----|
| 授权 | `https://iwx.workec.com/connect/oauth2/authorize` |
| 令牌 | `https://iwx.workec.com/connect/oauth2/token` |
| 用户信息 | `https://iwx.workec.com/connect/oauth2/get_user_info` |

---

## Nginx 配置

将以下配置加入你的 Nginx 站点配置文件（参考 `nginx-your-domain.example.com.conf`）：

```nginx
# EC OAuth2 回调（精确匹配）
location = /ecauth/auth/callback {
    proxy_pass http://127.0.0.1:3008/ecauth/auth/callback;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
}

# 平台主路径
location = /ecauth {
    return 301 /ecauth/;
}

location /ecauth/ {
    proxy_pass http://127.0.0.1:3008/ecauth/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
}
```

配置生效：

```bash
nginx -t && systemctl reload nginx
```

---

## 首个管理员引导

在 `.env` 中配置管理员标识（支持 EC 稳定用户标识、工号、邮箱、手机号）：

```env
PLATFORM_ADMIN_IDENTIFIERS=admin@company.com
```

该账号第一次通过 EC 登录时，平台会自动创建本地用户，并将 `status` 设为 `active`、`is_admin` 设为 `true`。

登录后访问以下页面验证：

- 平台首页：`https://your-domain.example.com/ecauth/`
- 管理后台：`https://your-domain.example.com/ecauth/admin`

---

## 接入子项目

### 1. 注册项目功能清单

```bash
npm run project:register -- --manifest manifests/example-project.json
```

或在管理后台 `/ecauth/admin` 中直接提交 manifest JSON。

### 2. 放行子项目回跳域名

在认证中心 `.env` 中增加子项目域名：

```env
ALLOWED_RETURN_TO_ORIGINS=https://crm.example.com
```

### 3. 一键生成子项目模板

```bash
npm run scaffold:subproject -- \
  --name sales-crm-web \
  --project-key sales-crm \
  --out-dir ../sales-crm-web \
  --port 3010
```

生成结果包含：`src/server.ts`、`.env.example`、`scripts/bundle.mjs`、`README.md`。

### 4. 子项目环境变量

```env
AUTH_PLATFORM_BASE_URL=http://localhost:3008/ecauth
SUBPROJECT_CALLBACK_URL=http://localhost:3010/auth/callback
PROJECT_TOKEN_SECRET=change_me_to_a_long_random_secret
```

### 5. 登录跳转示例

子项目将用户重定向到认证中心：

```
GET /ecauth/auth/login?projectKey=sales-crm&returnTo=http://localhost:3010/auth/callback
```

登录结果：

- 账号未审批 → 回跳并携带 `error=user_not_approved`
- 账号已审批且有权限 → 回跳并携带 `token=<project_access_token>`

### 可复用 SDK

仓库内置三个可直接复用的文件：

| 文件 | 用途 |
|------|------|
| `src/sdk/auth-platform-client.ts` | 构造登录地址、调用状态与权限检查接口 |
| `src/sdk/project-token.ts` | 校验项目访问令牌 |
| `src/sdk/express-integration.ts` | Express 接入中间件 |

完整示例见 `examples/subproject-server.ts`。

---

## 一键部署

仓库已内置 `deploy.sh`，执行以下步骤：

1. 本地构建（`npm run build`）
2. 同步 `dist/`、`public/`、`.env` 到远程服务器
3. 远程重启 PM2 进程并做健康检查

使用前确认脚本中的 `REMOTE`、`REMOTE_DIR`、`SSH_KEY` 参数，然后：

```bash
bash deploy.sh
```

> **注意：** `deploy.sh` 不会自动执行数据库初始化，首次部署前需手动运行 `npm run db:init`。

---

## EC OAuth2 集成要点

集成 EC SSO 最容易踩到的几个坑：

**Token 端点必须使用 HTTP Basic Auth**

EC 要求 client credentials 通过 `Authorization: Basic` Header 传递，放在 POST body 中会返回 `invalid_client`。

```typescript
const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
headers: {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Authorization': `Basic ${credentials}`,
}
```

**回调地址精确匹配**

`redirect_uri` 的协议、域名、路径、尾部斜杠必须与 EC 平台配置**完全一致**。

**必须处理回调 error 参数**

EC 回调可能携带 `error` 而非 `code`，未处理会导致用户看到空白页：

```typescript
const error = req.query.error as string;
if (error) {
  res.redirect(`/your-app/?error=${encodeURIComponent(error)}`);
  return;
}
```

**Nginx sites-enabled 同步问题**

若使用 `sites-available` + `sites-enabled` 模式，更新配置后需确认 `sites-enabled` 中的文件同步更新，否则旧配置仍会生效。用 `nginx -T` 验证实际加载的配置。

---

## 常见问题排查

| 问题 | 排查方向 |
|------|----------|
| 登录成功但回调报错 | 检查 `EC_REDIRECT_URI` 是否与 EC 平台配置完全一致；检查 Nginx 是否代理了 `/ecauth/auth/callback` |
| 管理员无法进入后台 | 检查是否命中 `PLATFORM_ADMIN_IDENTIFIERS`；检查 `users` 表中 `is_admin` 和 `status` 字段 |
| 子项目回跳失败 | 检查 `returnTo` 是否为绝对地址；检查 origin 是否在 `ALLOWED_RETURN_TO_ORIGINS` 中 |
| 用户有登录但拿不到项目令牌 | 检查用户 `status` 是否为 `active`；检查是否被授予该项目至少一个功能 |

快速排查命令：

```bash
# 查看应用日志
pm2 logs ecauth --lines 50 --nostream

# 查看 Nginx 访问日志
tail -50 /var/log/nginx/access.log | grep ecauth

# 验证 Nginx 实际加载的配置
nginx -T 2>&1 | grep -A5 "ecauth"

# 测试 token 端点
curl -sv -X POST 'https://iwx.workec.com/connect/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "Authorization: Basic $(echo -n 'client_id:client_secret' | base64)" \
  -d 'grant_type=authorization_code&code=TEST&redirect_uri=your_callback_url'
```

---

## 环境变量速查

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | ✅ | 服务监听端口，默认 `3008` |
| `APP_BASE_PATH` | ✅ | 应用挂载路径，默认 `/ecauth` |
| `DATABASE_URL` | ✅ | PostgreSQL 连接串 |
| `SESSION_SECRET` | ✅ | 会话签名密钥，使用高强度随机值 |
| `PROJECT_TOKEN_SECRET` | ✅ | 子项目令牌签名密钥，建议与 `SESSION_SECRET` 分开配置 |
| `PLATFORM_ADMIN_IDENTIFIERS` | ✅ | 首个管理员标识，支持邮箱、工号、手机号 |
| `ALLOWED_RETURN_TO_ORIGINS` | ✅ | 子项目回跳域名白名单，逗号分隔 |
| `EC_CLIENT_ID` | ✅ | EC 开放平台应用 ID |
| `EC_CLIENT_SECRET` | ✅ | EC 开放平台应用密钥 |
| `EC_REDIRECT_URI` | ✅ | OAuth2 回调地址，必须与 EC 平台配置一致 |
| `COOKIE_SECURE` | — | HTTPS 环境建议设为 `true` |
| `SESSION_TTL_HOURS` | — | 会话有效期（小时），默认 `12` |

---

## 上线检查清单

- [ ] PostgreSQL 数据库已初始化（`npm run db:init`）
- [ ] `.env` 所有必填项已配置
- [ ] EC 开放平台回调地址已填写且与 `EC_REDIRECT_URI` 一致
- [ ] Nginx 配置已加载（`nginx -t && systemctl reload nginx`）
- [ ] PM2 进程已启动（`pm2 status ecauth`）
- [ ] 健康检查通过（`curl http://127.0.0.1:3008/ecauth/health`）
- [ ] 管理员账号首次登录成功，可访问 `/ecauth/admin`
- [ ] 至少一个子项目已注册并完成端到端回跳测试

---

## License

MIT
