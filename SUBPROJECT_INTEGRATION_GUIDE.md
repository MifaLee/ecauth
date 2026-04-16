# 子项目接入指南

这个文档描述如何让新的 Node.js / Express 子项目快速纳入当前统一认证与授权平台。

## 接入目标

子项目接入后获得以下能力：

1. 登录统一跳转到认证中心。
2. 登录成功后认证中心签发项目范围访问令牌，并回跳子项目。
3. 子项目基于 `projectKey + featureKey` 做页面和接口访问控制。

## 推荐接入流程

1. 在认证中心注册项目及功能清单。
2. 在认证中心管理员控制台为用户授予功能。
3. 子项目接入共享中间件，接收认证中心签发的 `project` 令牌。

## 认证中心登录跳转

认证中心已支持以下登录参数：

- `projectKey`: 子项目标识。
- `returnTo`: 登录成功后的回跳地址。

示例：

```text
GET /ecauth/auth/login?projectKey=sales-crm&returnTo=http://localhost:3010/auth/callback
```

用户在认证中心完成登录后：

1. 如果账号尚未审核，会回跳子项目并带 `error=user_not_approved`。
2. 如果账号已审核且拥有该项目权限，会回跳子项目并带 `token=<project_access_token>`。

## 回跳地址白名单

认证中心通过环境变量 `ALLOWED_RETURN_TO_ORIGINS` 控制允许的子项目来源。例如：

```env
ALLOWED_RETURN_TO_ORIGINS=http://localhost:3010,https://crm.example.com
```

只有白名单中的 origin 才允许作为 `returnTo`。

## 可复用 SDK

仓库里已经提供了三个可复用文件：

- [src/sdk/auth-platform-client.ts](/Users/mifalee/development/ecauth/src/sdk/auth-platform-client.ts): 构造登录地址、调用认证中心状态与权限检查接口。
- [src/sdk/project-token.ts](/Users/mifalee/development/ecauth/src/sdk/project-token.ts): 校验项目访问令牌。
- [src/sdk/express-integration.ts](/Users/mifalee/development/ecauth/src/sdk/express-integration.ts): Express 子项目接入中间件。

## 一键生成子项目模板

仓库已经内置脚手架命令：

```bash
npm run scaffold:subproject -- \
	--name sales-crm-web \
	--project-key sales-crm \
	--out-dir ../sales-crm-web \
	--port 3010
```

可选参数：

- `--auth-base-url`: 认证中心地址，默认 `http://localhost:3008/ecauth`
- `--callback-url`: 子项目登录回调地址，默认按 `port` 自动生成

生成结果会包含：

- `src/server.ts`: 登录跳转、回调处理、权限校验示例
- `.env.example`: 子项目环境变量模板
- `scripts/bundle.mjs`: 构建脚本
- `README.md`: 子项目接入说明

## Express 子项目示例

完整示例见 [examples/subproject-server.ts](/Users/mifalee/development/ecauth/examples/subproject-server.ts)。

该示例实现了：

1. `/login` 跳转到认证中心。
2. `/auth/callback` 接收项目访问令牌并写入本地 Cookie。
3. `/dashboard` 只要求登录即可访问。
4. `/reports` 需要 `report:export` 功能权限。

## 子项目环境变量建议

```env
AUTH_PLATFORM_BASE_URL=http://localhost:3008/ecauth
SUBPROJECT_CALLBACK_URL=http://localhost:3010/auth/callback
PROJECT_TOKEN_SECRET=change_me_to_a_long_random_secret
```

## 关于 `PROJECT_TOKEN_SECRET`

当前方案使用对称签名，子项目通过同一个 `PROJECT_TOKEN_SECRET` 验证令牌，因此部署时应视为同一信任域内的内部系统。

如果后续子项目数量继续增加，建议升级为非对称签名或 JWKS 发布模式，避免多个子项目共享签名密钥。