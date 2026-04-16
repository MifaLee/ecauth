# __PROJECT_NAME__

这是基于统一认证平台生成的子项目模板。

## 初始化

1. 安装依赖

```bash
npm install
```

2. 复制 `.env.example` 为 `.env` 并检查以下配置：

- `AUTH_PLATFORM_BASE_URL`
- `PROJECT_KEY`
- `PROJECT_TOKEN_SECRET`
- `SUBPROJECT_CALLBACK_URL`

3. 启动开发服务

```bash
npm run dev
```

## 路由说明

- `/login`: 跳转统一认证平台
- `/auth/callback`: 接收项目访问令牌
- `/dashboard`: 需要项目登录
- `/reports`: 需要 `report:export` 功能权限

## 对接要求

在统一认证平台中：

1. 已注册 `projectKey = __PROJECT_KEY__`
2. 已将回跳地址加入 `ALLOWED_RETURN_TO_ORIGINS`
3. 已为用户授予对应功能权限