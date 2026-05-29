-- ec-ipaas 项目注册脚本
-- 在认证中心注册 ec-ipaas 子项目及其功能权限点
-- 执行方式：psql $DATABASE_URL -f register-ecipaas.sql

-- 1. 注册项目
INSERT INTO projects (project_key, name, description)
VALUES (
  'ec-ipaas',
  'EC-iPaaS 数据集成管理平台',
  '多租户模板版本管理、实例调度、凭证安全注入与运行可观测'
)
ON CONFLICT (project_key) DO UPDATE
  SET name        = EXCLUDED.name,
      description = EXCLUDED.description,
      updated_at  = NOW();

-- 2. 注册功能权限点
WITH proj AS (
  SELECT id FROM projects WHERE project_key = 'ec-ipaas'
)
INSERT INTO features (project_id, feature_key, name, description)
SELECT
  proj.id,
  f.feature_key,
  f.name,
  f.description
FROM proj,
  (VALUES
    ('templates:manage',  '模板管理', '创建、编辑和管理集成模板'),
    ('instances:manage',  '实例管理', '创建、触发和回滚集成实例'),
    ('executions:view',   '执行记录', '查看执行历史、日志与指标'),
    ('dashboard:view',    '仪表盘',   '查看版本对比、锁冲突与幂等性统计')
  ) AS f(feature_key, name, description)
ON CONFLICT (project_id, feature_key) DO UPDATE
  SET name        = EXCLUDED.name,
      description = EXCLUDED.description,
      updated_at  = NOW();

-- 3. 验证注册结果
SELECT
  p.project_key,
  p.name AS project_name,
  f.feature_key,
  f.name AS feature_name
FROM projects p
JOIN features f ON f.project_id = p.id
WHERE p.project_key = 'ec-ipaas'
ORDER BY f.feature_key;
