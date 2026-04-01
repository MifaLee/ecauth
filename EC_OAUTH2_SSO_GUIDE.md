# EC OAuth2 SSO 单点登录集成开发指南

> 基于 eclogindemo 项目的实战经验总结，供后续其它项目集成 EC SSO 时参考。

---

## 一、EC OAuth2 认证流程概述

EC 使用标准 OAuth2 Authorization Code 流程（同时兼容 OIDC），整体流程如下：

```
用户浏览器                  你的服务端                     EC OAuth2 服务器
    |                          |                              |
    |  1. 访问登录入口          |                              |
    |------------------------->|                              |
    |                          |  2. 302 重定向到 EC 授权页     |
    |<-------------------------|                              |
    |                                                         |
    |  3. 用户在 EC 页面登录并授权                               |
    |-------------------------------------------------------->|
    |                                                         |
    |  4. EC 回调 redirect_uri，携带 authorization code        |
    |<--------------------------------------------------------|
    |                          |                              |
    |                          |  5. 服务端用 code 换 token    |
    |                          |----------------------------->|
    |                          |                              |
    |                          |  6. 返回 access_token 等     |
    |                          |<-----------------------------|
    |                          |                              |
    |                          |  7. 用 access_token 获取用户信息|
    |                          |----------------------------->|
    |                          |                              |
    |                          |  8. 返回用户信息              |
    |                          |<-----------------------------|
    |                                                         |
    |  9. 重定向到前端页面，携带登录结果                          |
    |<-------------------------|                              |
```

## 二、EC 开放平台配置

### 2.1 创建应用

在 EC 开放平台（`iwx.workec.com`）创建 OAuth2 应用，获取：

- **client_id** — 应用标识
- **client_secret** — 应用密钥

### 2.2 配置回调地址

在应用设置中填写 **授权回调地址（redirect_uri）**，例如：

```
https://your-domain.com/api/ec-oauth/callback
```

> **重要：** 回调地址必须与代码中 `EC_REDIRECT_URI` 完全一致（包括协议 http/https、有无尾部斜杠），否则 EC 会返回 `server_error`。

### 2.3 EC OAuth2 端点

| 端点 | URL |
|------|-----|
| 授权（Authorize） | `https://iwx.workec.com/connect/oauth2/authorize` |
| 令牌（Token） | `https://iwx.workec.com/connect/oauth2/token` |
| 用户信息（UserInfo） | `https://iwx.workec.com/connect/oauth2/get_user_info` |

## 三、项目架构

### 3.1 目录结构

```
eclogindemo/
├── src/
│   └── server.ts          # 服务端（Express），核心 OAuth2 逻辑
├── public/
│   └── index.html          # 前端页面（纯静态，展示登录结果）
├── scripts/
│   └── bundle.mjs          # esbuild 构建脚本
├── .env                    # 环境变量（敏感信息，不入版本库）
├── .env.example            # 环境变量模板
├── nginx-your-domain.example.com.conf  # Nginx 反向代理配置
├── deploy.sh               # 一键部署脚本
├── package.json
└── tsconfig.json
```

### 3.2 环境变量

```env
PORT=3008
EC_CLIENT_ID=your_client_id
EC_CLIENT_SECRET=your_client_secret
EC_AUTHORIZE_URL=https://iwx.workec.com/connect/oauth2/authorize
EC_TOKEN_URL=https://iwx.workec.com/connect/oauth2/token
EC_USERINFO_URL=https://iwx.workec.com/connect/oauth2/get_user_info
EC_REDIRECT_URI=https://your-domain.com/api/ec-oauth/callback
```

### 3.3 技术栈

- **Node.js** + **Express** — 服务端框架
- **TypeScript** — 开发语言
- **esbuild** — 打包构建
- **PM2** — 进程管理
- **Nginx** — 反向代理

## 四、核心代码实现

### 4.1 第一步：发起授权请求

将用户重定向到 EC 授权页面：

```typescript
app.get('/your-app/auth/login', (_req, res) => {
  const authorizeUrl = process.env.EC_AUTHORIZE_URL!;
  const params = new URLSearchParams({
    client_id: process.env.EC_CLIENT_ID!,
    redirect_uri: process.env.EC_REDIRECT_URI!,
    response_type: 'code',
    scope: 'openid',
  });
  res.redirect(`${authorizeUrl}?${params.toString()}`);
});
```

**参数说明：**
- `response_type: 'code'` — 使用 Authorization Code 模式
- `scope: 'openid'` — OIDC 标准范围
- `redirect_uri` — 必须与 EC 平台配置的回调地址**完全一致**

### 4.2 第二步：处理回调，用 code 换 token

EC 授权成功后，会回调 `redirect_uri` 并携带 `code` 参数：

```typescript
app.get('/your-app/auth/callback', async (req, res) => {
  // ===== 重要：处理 EC 返回的错误 =====
  const error = req.query.error as string;
  const errorDescription = req.query.error_description as string;
  if (error) {
    console.error('[OAuth2 Callback Error]', error, errorDescription);
    // 跳转到前端错误页面，而不是返回纯文本
    res.redirect(`/your-app/?error=${encodeURIComponent(errorDescription)}`);
    return;
  }

  const code = req.query.code as string;
  if (!code) {
    res.status(400).send('Missing authorization code');
    return;
  }

  // ===== 关键：使用 HTTP Basic Auth 传递 client credentials =====
  const credentials = Buffer.from(
    `${process.env.EC_CLIENT_ID}:${process.env.EC_CLIENT_SECRET}`
  ).toString('base64');

  const tokenResponse = await fetch(process.env.EC_TOKEN_URL!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,  // Basic Auth
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.EC_REDIRECT_URI!,
    }).toString(),
  });

  const tokenData = await tokenResponse.json();
  // tokenData 包含: access_token, token_type, expires_in, refresh_token 等
});
```

### 4.3 第三步：获取用户信息

```typescript
const userinfoResponse = await fetch(process.env.EC_USERINFO_URL!, {
  headers: {
    Authorization: `Bearer ${tokenData.access_token}`,
  },
});
const userinfo = await userinfoResponse.json();
// userinfo 包含: emp_id, emp_name, email, mobile 等
```

## 五、踩坑记录与关键注意事项

### 5.1 Token 端点必须使用 HTTP Basic Auth

**这是最大的坑。** EC 的 token 端点要求 client credentials 通过 HTTP Basic Auth 传递（`Authorization: Basic base64(client_id:client_secret)`），而不是放在 POST body 里。

| 方式 | 结果 |
|------|------|
| body 中传 `client_id` + `client_secret` | `invalid_client` - Client authentication failed |
| HTTP Basic Auth（Header） | 认证通过 |

错误写法：
```typescript
// 错误：client_id/client_secret 放在 body 中
body: new URLSearchParams({
  client_id: 'xxx',
  client_secret: 'xxx',
  grant_type: 'authorization_code',
  code,
  redirect_uri: '...',
})
```

正确写法：
```typescript
// 正确：使用 Authorization: Basic header
const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
headers: {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Authorization': `Basic ${credentials}`,
},
body: new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  redirect_uri: '...',
})
```

### 5.2 回调路由需要与 EC 平台配置一致

EC 平台上配置的回调地址必须与代码中的 `EC_REDIRECT_URI` **精确匹配**：

- 协议必须一致（http vs https）
- 域名必须一致
- 路径必须一致
- 不能多或少尾部斜杠

如果不一致，EC 会返回：
```
error=server_error
error_description=The authorization server encountered an unexpected condition...
```

### 5.3 Nginx 回调路由配置

如果回调 URL 和应用 URL 路径不同（例如回调用 `/api/ec-oauth/callback`，应用在 `/eclogindemo/`），需要在 Nginx 中单独配置 location：

```nginx
# OAuth2 回调路由 - 精确匹配，代理到应用服务
location = /api/ec-oauth/callback {
    proxy_pass http://127.0.0.1:3008/eclogindemo/auth/callback;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
}
```

### 5.4 Nginx sites-available vs sites-enabled

**注意：** 如果 Nginx 使用 `sites-available` + `sites-enabled` 模式：

1. 确认 `sites-enabled` 中的文件是 `sites-available` 的**软链接还是独立副本**
2. 如果是独立副本，更新配置时必须**同时更新两个位置**，或使用 `cp` 同步
3. 更新后务必用 `nginx -T | grep your-config` 验证实际生效的配置

验证方法：
```bash
# 检查是否是软链接
ls -la /etc/nginx/sites-enabled/your-config

# 对比两个文件的 md5
md5sum /etc/nginx/sites-available/your-config /etc/nginx/sites-enabled/your-config

# 查看实际生效的配置
nginx -T 2>&1 | grep -A5 "your-location"
```

### 5.5 回调错误处理

EC 回调时可能带 `error` 参数而非 `code` 参数，必须处理：

```typescript
// 必须先检查 error
const error = req.query.error as string;
if (error) {
  // 不要返回纯文本，要重定向到前端展示错误
  res.redirect(`/your-app/?data=${encodeURIComponent(JSON.stringify({ error }))}`);
  return;
}
```

不处理的话，用户会看到空白页或 400 错误。

### 5.6 Nginx 301 重定向会丢失 query string

Nginx 的 `return 301` 重定向**可能会丢失 query string**（取决于配置）。如果回调后重定向到前端时带有 query 参数（如 `?data=...`），确保：

1. 目标路径末尾有 `/`，避免触发 301
2. 或者使用 `try_files` 而非 `return 301`

## 六、部署清单

### 6.1 首次部署

1. **EC 平台配置**：创建应用、获取 client_id/secret、设置回调地址
2. **服务端部署**：
   - 配置 `.env`（client_id、client_secret、回调地址等）
   - 构建项目（`npm run build`）
   - 上传到服务器（rsync/scp）
   - PM2 启动（`pm2 start dist/server.js --name your-app`）
3. **Nginx 配置**：
   - 添加应用的 location 块
   - 添加回调路由的 location 块
   - `nginx -t && nginx -s reload`
4. **验证**：
   - `curl http://127.0.0.1:PORT/your-app/health`
   - 浏览器访问完整流程

### 6.2 更新部署

```bash
npm run build                          # 构建
bash deploy.sh                         # 构建并部署到服务器
# 如有 nginx 配置变更，需额外同步：
scp nginx.conf server:/etc/nginx/sites-available/xxx
cp /etc/nginx/sites-available/xxx /etc/nginx/sites-enabled/xxx  # 注意要同步
nginx -t && nginx -s reload
```

### 6.3 排查问题的方法

```bash
# 查看 Nginx 访问日志，追踪完整请求链路
tail -50 /var/log/nginx/access.log | grep your-app

# 查看 PM2 应用日志
pm2 logs your-app --lines 30 --nostream

# 直接测试 token 端点（用 Basic Auth）
curl -sv -X POST 'https://iwx.workec.com/connect/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "Authorization: Basic $(echo -n 'client_id:client_secret' | base64)" \
  -d 'grant_type=authorization_code&code=TEST&redirect_uri=your_callback_url'

# 直接测试回调处理
curl -sv 'http://127.0.0.1:PORT/your-app/auth/callback?code=test'

# 验证 Nginx 实际配置
nginx -T 2>&1 | grep -A5 "your-location"
```

## 七、集成到已有项目的步骤

如果需要在已有项目中集成 EC SSO，最小改动如下：

### 7.1 最小必要代码

只需添加 3 个路由：

| 路由 | 功能 |
|------|------|
| `GET /auth/login` | 重定向到 EC 授权页 |
| `GET /auth/callback` | 处理 EC 回调，换 token，获取用户信息 |
| 前端登录按钮 | 跳转到 `/auth/login` |

### 7.2 最小必要配置

只需 5 个环境变量：

```env
EC_CLIENT_ID=xxx
EC_CLIENT_SECRET=xxx
EC_AUTHORIZE_URL=https://iwx.workec.com/connect/oauth2/authorize
EC_TOKEN_URL=https://iwx.workec.com/connect/oauth2/token
EC_REDIRECT_URI=https://your-domain.com/your-callback-path
```

### 7.3 核心要点回顾

1. Token 请求必须用 **HTTP Basic Auth**
2. `redirect_uri` 必须与 EC 平台**精确一致**
3. Nginx 必须正确代理**回调路由**
4. 必须处理 EC 回调的 **error 参数**
5. 部署后确认 **Nginx 配置真正生效**（sites-enabled 同步问题）

---

*最后更新：2026-03-31，基于 eclogindemo 项目实战调试总结*
