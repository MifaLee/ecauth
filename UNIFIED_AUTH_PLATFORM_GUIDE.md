# EC 统一认证与授权平台说明

本项目已从 EC OAuth2 登录演示，改造成一个基于 TypeScript + Node.js + PostgreSQL 的统一认证与授权基础架构，目标是承载后续多个子项目的统一登录、用户管理、审批与功能授权。

如果你要直接落地部署，优先阅读 [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md)。

## 能力范围

1. EC 账号 SSO 单点登录。
2. 用户首次登录自动注册，本地状态默认为 `pending_review`。
3. 管理员审核用户，批准后用户状态切换为 `active`。
4. 管理员按 `projectKey + featureKey` 维度授予权限。
5. 新项目通过 manifest 清单快速注册到权限中心。
6. 子项目可调用统一接口校验权限，或申请短期项目令牌。
7. 可从 EC 组织架构同步部门与成员，预创建本地账号并配置部门自动授权规则。

## 核心数据模型

PostgreSQL 中包含以下核心表：

- `users`: 本地用户主表，保存状态、管理员标识、审批结果。
- `ec_identities`: EC 身份映射表，绑定 EC 用户与本地用户。
- `ec_org_units`: EC 部门缓存表。
- `ec_org_members`: EC 成员缓存表，以及与本地用户的映射。
- `ec_org_grant_rules`: 部门到功能点的自动授权规则。
- `projects`: 子项目注册表。
- `features`: 子项目功能点表。
- `user_feature_grants`: 用户功能授权关系。
- `audit_logs`: 登录、审批、授权、项目注册等审计记录。

## 用户生命周期

1. 用户访问 `/ecauth/auth/login` 跳转到 EC。
2. EC 回调 `/ecauth/auth/callback`。
3. 服务端使用授权码换取 access token，再获取 EC 用户资料。
4. 平台将 EC 身份同步到本地库。
5. 若为首次登录用户，则创建本地账号，状态为 `pending_review`。
6. 管理员审核通过后，用户状态改为 `active`，并可继续授予具体功能权限。

## 管理员引导

首个管理员可通过环境变量 `PLATFORM_ADMIN_IDENTIFIERS` 进行引导。支持匹配以下标识之一：

- EC 的稳定用户标识
- 工号
- 邮箱
- 手机号

匹配成功的账号首次登录时会自动成为 `active` 且 `is_admin = true`。

## 初始化步骤

1. 配置 `.env`，至少补齐数据库连接、EC OAuth2 参数、`SESSION_SECRET`。
2. 初始化数据库：

```bash
npm run db:init
```

3. 启动开发服务：

```bash
npm run dev
```

## 组织同步配置

如果你要启用 EC 组织同步与预授权，需要在 `.env` 中补齐以下配置：

```env
EC_OPEN_API_BASE_URL=https://open.workec.com
EC_OPEN_CORP_ID=21299
EC_OPEN_APP_ID=38647944873775104
EC_OPEN_APP_SECRET=your_open_api_secret
```

完成配置后，可以通过后台“组织同步”页触发同步，也可以直接从命令行执行：

```bash
npm run org:sync
```

如果希望审计日志记录为某个管理员触发，可以带上：

```bash
npm run org:sync -- --actor-user-id <admin_user_id>
```

如果命令返回“请求IP不合法”，说明 EC 企业管理后台的 OpenAPI IP 白名单还没有放行当前服务器或开发机出口 IP。需要先在 EC 管理后台把实际出口 IP 加入白名单，再重新执行组织同步。

## 管理接口

当前项目首页已经内置一个最小可用管理员控制台。管理员登录后，可以直接在页面上完成：

- 审核用户
- 设定或取消管理员
- 授予或撤销功能权限
- 注册新项目与功能清单

此外，已经拆出独立管理后台页面：

- `/ecauth/admin`: 独立管理员工作台

该页面支持：

- 用户搜索与状态筛选
- 批量审批
- 批量授权与批量撤销
- 审批备注录入
- 项目清单注册与查看
- EC 组织同步、组织成员直接授权
- 部门自动授权规则配置与删除

下面的 API 仍然保留，便于后续独立后台或其他系统集成。

### 获取当前会话

```http
GET /ecauth/api/auth/me
```

### 查询用户是否拥有某功能

```http
GET /ecauth/api/access/check?projectKey=sales-crm&featureKey=dashboard:view
```

### 申请项目范围令牌

```http
POST /ecauth/api/auth/project-token
Content-Type: application/json

{
  "projectKey": "sales-crm"
}
```

### 查看所有用户

```http
GET /ecauth/api/admin/users
```

### 审核用户

```http
POST /ecauth/api/admin/users/:userId/review
Content-Type: application/json

{
  "action": "approve",
  "note": "允许使用销售 CRM"
}
```

### 授权功能

```http
POST /ecauth/api/admin/users/:userId/grants
Content-Type: application/json

{
  "grants": [
    { "projectKey": "sales-crm", "featureKey": "dashboard:view" },
    { "projectKey": "sales-crm", "featureKey": "report:export" }
  ]
}
```

## 新项目接入方式

### 方式一：manifest + CLI

在 [manifests/example-project.json](/Users/mifalee/development/ecauth/manifests/example-project.json) 的格式基础上定义你的项目功能清单，然后执行：

```bash
npm run project:register -- --manifest manifests/example-project.json
```

这会自动向 `projects` 和 `features` 表做 upsert，不需要手工改库。

### 方式一补充：一键生成子项目模板

如果你要新建一个标准 Node.js/Express 子项目，可以直接生成脚手架：

```bash
npm run scaffold:subproject -- --name sales-crm-web --project-key sales-crm --out-dir ../sales-crm-web
```

该命令会输出一套可运行模板，内置统一登录跳转、项目令牌回调处理和权限中间件示例。

### 方式二：管理员接口

```http
POST /ecauth/api/admin/projects/register
Content-Type: application/json

{
  "projectKey": "sales-crm",
  "name": "销售 CRM",
  "features": [
    { "key": "dashboard:view", "name": "查看销售看板" }
  ]
}
```

### 方式三：子项目回跳登录

认证中心现在支持子项目直接发起登录并在成功后回跳：

```text
/ecauth/auth/login?projectKey=sales-crm&returnTo=http://localhost:3010/auth/callback
```

该模式适合新项目快速纳入统一架构。子项目不需要自己对接 EC OAuth2，只需要：

1. 在平台注册 `projectKey` 和功能清单。
2. 配置自己的回跳地址到 `ALLOWED_RETURN_TO_ORIGINS`。
3. 接收认证中心签发的项目令牌并做本地校验。

## 子项目推荐接入模式

1. 子项目仍然把 EC 登录入口统一指向本平台。
2. 子项目接收本平台颁发的会话 Cookie，或在服务端调用项目令牌接口获取短期 Token。
3. 每个受保护的业务功能都映射到一个 `projectKey + featureKey`。
4. 页面按钮显隐、接口访问控制都以统一权限检查结果为准。

更完整的接入说明见 [SUBPROJECT_INTEGRATION_GUIDE.md](/Users/mifalee/development/ecauth/SUBPROJECT_INTEGRATION_GUIDE.md)。

## 后续可继续扩展的方向

1. 增加管理员前端界面，而不只依赖 API。
2. 将项目令牌升级为公私钥签名，便于多服务独立校验。
3. 增加组织、角色组、批量授权模板。
4. 接入审批流和通知机制。