# EC 统一认证平台部署落地手册

这份手册面向实际部署，覆盖以下完整链路：

1. PostgreSQL 初始化
2. 认证中心环境变量配置
3. 首个管理员引导
4. PM2 + Nginx 部署
5. EC 开放平台回调配置
6. 新子项目纳管流程

---

## 1. 部署目标

认证中心对外提供以下关键能力：

- `EC SSO` 登录入口
- 本地用户注册与审批
- 功能级授权管理
- 子项目项目令牌签发
- 独立管理后台 `/ecauth/admin`

当前仓库的现网约定如下：

- 应用端口：`3008`
- 对外路径：`/ecauth/`
- 远程部署目录：`/home/ecauth`
- PM2 进程名：`ecauth`

---

## 2. 前置准备

部署前需要确认：

1. 已有 Node.js 20+ 环境。
2. 已有 PostgreSQL 14+ 或兼容版本。
3. 服务器已安装 PM2。
4. Nginx 已可代理 `your-domain.example.com`。
5. EC 开放平台已创建应用，并拿到 `client_id` 与 `client_secret`。

建议的系统目录：

```bash
mkdir -p /home/ecauth/dist
mkdir -p /home/ecauth/public
```

---

## 3. 数据库初始化

### 3.1 创建数据库

示例：

```sql
CREATE DATABASE ecauth;
```

### 3.2 配置连接串

在 `.env` 中配置：

```env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ecauth
DATABASE_SSL=false
```

### 3.3 初始化表结构

本地或服务器执行：

```bash
npm run db:init
```

该命令会执行 [db/schema.sql](db/schema.sql)。

初始化完成后应具备以下核心表：

- `users`
- `ec_identities`
- `projects`
- `features`
- `user_feature_grants`
- `audit_logs`

---

## 4. 环境变量配置

建议以 [.env.example](.env.example) 为模板生成 `.env`，至少需要以下参数：

```env
PORT=3008
APP_BASE_PATH=/ecauth

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ecauth
DATABASE_SSL=false

SESSION_SECRET=change_me_to_a_long_random_secret
PROJECT_TOKEN_SECRET=change_me_to_a_long_random_secret
COOKIE_SECURE=false
SESSION_TTL_HOURS=12

PLATFORM_ADMIN_IDENTIFIERS=admin@example.com,10001
ALLOWED_RETURN_TO_ORIGINS=http://localhost:3010,https://crm.example.com

EC_CLIENT_ID=your_client_id
EC_CLIENT_SECRET=your_client_secret
EC_AUTHORIZE_URL=https://iwx.workec.com/connect/oauth2/authorize
EC_TOKEN_URL=https://iwx.workec.com/connect/oauth2/token
EC_USERINFO_URL=https://iwx.workec.com/connect/oauth2/get_user_info
EC_REDIRECT_URI=https://your-domain.example.com/ecauth/auth/callback
```

### 关键说明

#### `SESSION_SECRET`

用于认证中心会话签名，必须使用高强度随机值。

#### `PROJECT_TOKEN_SECRET`

用于子项目访问令牌签名。当前实现为对称签名，建议与 `SESSION_SECRET` 分开配置。

#### `PLATFORM_ADMIN_IDENTIFIERS`

用于引导首个管理员。支持匹配：

- EC 稳定用户标识
- 工号
- 邮箱
- 手机号

#### `ALLOWED_RETURN_TO_ORIGINS`

子项目回跳白名单，必须配置所有允许的子项目域名或本地开发地址。

---

## 5. 首个管理员引导

这是部署最关键的一步。

### 5.1 配置管理员标识

例如：

```env
PLATFORM_ADMIN_IDENTIFIERS=admin@company.com
```

或：

```env
PLATFORM_ADMIN_IDENTIFIERS=10001
```

### 5.2 管理员首次登录

当该账号第一次通过 EC 登录时：

1. 平台会自动创建本地用户。
2. 用户状态直接设为 `active`。
3. `is_admin = true`。

### 5.3 验证方式

首次登录后访问：

- 平台首页：`/ecauth/`
- 管理后台：`/ecauth/admin`

如果能进入独立后台并看到用户、项目管理区域，管理员引导成功。

---

## 6. EC 开放平台配置

EC 应用配置里，回调地址必须与 `.env` 中的 `EC_REDIRECT_URI` 完全一致。

当前建议配置为：

```text
https://your-domain.example.com/ecauth/auth/callback
```

Nginx 会把这个地址代理到：

```text
http://127.0.0.1:3008/ecauth/auth/callback
```

这一段已存在于 [nginx-your-domain.example.com.conf](nginx-your-domain.example.com.conf)。

---

## 7. Nginx 配置

当前仓库中的 [nginx-your-domain.example.com.conf](nginx-your-domain.example.com.conf) 已包含认证中心所需的两段关键配置。

### 7.1 EC 回调代理

```nginx
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
```

### 7.2 平台主路径代理

```nginx
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

### 7.3 变更后生效

```bash
nginx -t
systemctl reload nginx
```

---

## 8. PM2 启动与应用发布

### 8.1 本地构建

```bash
npm run build
```

### 8.2 远程目录结构

部署后至少包含：

```text
/home/ecauth/
  dist/
  public/
  .env
```

### 8.3 PM2 启动命令

首次启动：

```bash
cd /home/ecauth
pm2 start dist/server.js --name ecauth
pm2 save
```

重启：

```bash
pm2 restart ecauth
pm2 save
```

### 8.4 健康检查

```bash
curl -sf http://127.0.0.1:3008/ecauth/health
```

预期返回：

```json
{"status":"ok","service":"ecauth","version":"2.0.0"}
```

---

## 9. 使用现有 deploy.sh 发布

当前仓库已带 [deploy.sh](deploy.sh)，默认行为是：

1. 本地执行 `npm run build`
2. 同步 `dist/`
3. 同步 `public/`
4. 同步 `.env`
5. 远程重启 PM2 进程并做健康检查

使用前需要确认以下参数是否正确：

- `REMOTE`
- `REMOTE_DIR`
- `SSH_KEY`

执行方式：

```bash
bash deploy.sh
```

### 注意事项

该脚本不会自动执行 `npm run db:init`，因此：

- 首次部署前需要手动初始化数据库。
- 表结构变更后也需要单独执行数据库迁移或重跑初始化脚本。

---

## 10. 上线后验证清单

部署完成后按以下顺序验证：

### 10.1 服务健康

```bash
curl -sf http://127.0.0.1:3008/ecauth/health
curl -I https://your-domain.example.com/ecauth/
```

### 10.2 EC 登录

浏览器访问：

```text
https://your-domain.example.com/ecauth/
```

检查是否可正常跳转 EC 登录并回到平台首页。

### 10.3 管理后台

浏览器访问：

```text
https://your-domain.example.com/ecauth/admin
```

确认：

1. 可以看到用户列表。
2. 可以筛选用户。
3. 可以审批与批量授权。
4. 可以注册项目。

### 10.4 项目注册

执行：

```bash
npm run project:register -- --manifest manifests/example-project.json
```

确认后台项目目录出现对应 `projectKey` 和 `featureKey`。

### 10.5 子项目回跳登录

访问示例子项目登录地址或手工构造：

```text
https://your-domain.example.com/ecauth/auth/login?projectKey=sales-crm&returnTo=https://crm.example.com/auth/callback
```

确认：

1. 未审批用户会被拒绝进入子项目。
2. 已审批且有权限用户会拿到项目令牌。

---

## 11. 新子项目纳管流程

一个新项目进入统一架构时，建议按以下步骤执行。

### 步骤 1：注册项目功能清单

```bash
npm run project:register -- --manifest manifests/example-project.json
```

或在后台 `/ecauth/admin` 中直接提交 manifest JSON。

### 步骤 2：放行子项目回跳域名

在认证中心 `.env` 中增加：

```env
ALLOWED_RETURN_TO_ORIGINS=https://crm.example.com
```

修改后重新部署认证中心。

### 步骤 3：生成子项目模板

```bash
npm run scaffold:subproject -- --name sales-crm-web --project-key sales-crm --out-dir ../sales-crm-web
```

### 步骤 4：子项目配置环境变量

至少补齐：

- `AUTH_PLATFORM_BASE_URL`
- `PROJECT_KEY`
- `PROJECT_TOKEN_SECRET`
- `SUBPROJECT_CALLBACK_URL`

### 步骤 5：管理员授权用户

在 `/ecauth/admin` 中批量或单独授予功能。

---

## 12. 常见故障排查

### 问题 1：登录成功但回调报错

优先检查：

1. `EC_REDIRECT_URI` 与 EC 平台配置是否完全一致。
2. Nginx 是否正确代理 `/ecauth/auth/callback`。

### 问题 2：管理员无法进入后台

检查：

1. 该用户是否命中 `PLATFORM_ADMIN_IDENTIFIERS`。
2. `users` 表中的 `status` 是否为 `active`。
3. `is_admin` 是否为 `true`。

### 问题 3：子项目回跳失败

检查：

1. `returnTo` 是否为绝对地址。
2. `returnTo` 的 origin 是否在 `ALLOWED_RETURN_TO_ORIGINS` 中。
3. 子项目 `PROJECT_KEY` 是否与平台注册一致。

### 问题 4：用户已登录但拿不到项目令牌

检查：

1. 用户状态是否为 `active`。
2. 用户是否被授予该项目至少一个功能。

---

## 13. 推荐上线顺序

建议的实际落地顺序：

1. 初始化 PostgreSQL。
2. 配置 `.env`。
3. 配置 EC 开放平台回调地址。
4. 配置 Nginx。
5. 启动 PM2。
6. 首个管理员登录验证。
7. 注册首个业务项目。
8. 生成并接入首个子项目模板。

完成以上步骤后，这个仓库就可以作为统一认证与授权平台投入使用。