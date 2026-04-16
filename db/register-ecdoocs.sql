-- ecdoocs 项目注册脚本
-- 在认证中心注册 ecdoocs 子项目及其功能权限点
-- 执行方式：psql $DATABASE_URL -f register-ecdoocs.sql

-- 1. 注册项目
INSERT INTO projects (project_key, name, description)
VALUES (
  'ecdoocs',
  'EC Markdown 编辑器',
  '微信 Markdown 编辑器，支持乐享知识库导入、公众号文章发布与管理'
)
ON CONFLICT (project_key) DO UPDATE
  SET name        = EXCLUDED.name,
      description = EXCLUDED.description,
      updated_at  = NOW();

-- 2. 注册功能权限点
WITH proj AS (
  SELECT id FROM projects WHERE project_key = 'ecdoocs'
)
INSERT INTO features (project_id, feature_key, name, description)
SELECT
  proj.id,
  f.feature_key,
  f.name,
  f.description
FROM proj,
  (VALUES
    ('lexiang:knowledge-base', '乐享知识库',     '从乐享知识库导入文档内容'),
    ('wechat:publish',         '公众号发布',     '将 Markdown 文章发布到微信公众号'),
    ('wechat:delete',          '公众号文章删除', '查看并删除已发布的微信公众号文章')
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
WHERE p.project_key = 'ecdoocs'
ORDER BY f.feature_key;
