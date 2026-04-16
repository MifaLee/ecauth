CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ec_user_id TEXT,
  ec_employee_id TEXT,
  ec_dept_id BIGINT,
  ec_title TEXT,
  email TEXT,
  mobile TEXT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'active', 'rejected', 'disabled')),
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  provision_source TEXT NOT NULL DEFAULT 'first_login' CHECK (provision_source IN ('first_login', 'org_sync')),
  review_note TEXT,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS ec_user_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ec_dept_id BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ec_title TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS provision_source TEXT NOT NULL DEFAULT 'first_login';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_provision_source_check;
ALTER TABLE users
  ADD CONSTRAINT users_provision_source_check CHECK (provision_source IN ('first_login', 'org_sync'));

CREATE UNIQUE INDEX IF NOT EXISTS users_ec_user_id_unique ON users (ec_user_id) WHERE ec_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_mobile_unique ON users (mobile) WHERE mobile IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_employee_unique ON users (ec_employee_id) WHERE ec_employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ec_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  mobile TEXT,
  raw_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, feature_key)
);

CREATE TABLE IF NOT EXISTS user_feature_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  grant_source TEXT NOT NULL DEFAULT 'manual',
  grant_source_ref TEXT,
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, feature_id)
);

ALTER TABLE user_feature_grants ADD COLUMN IF NOT EXISTS grant_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE user_feature_grants ADD COLUMN IF NOT EXISTS grant_source_ref TEXT;
ALTER TABLE user_feature_grants DROP CONSTRAINT IF EXISTS user_feature_grants_grant_source_check;
ALTER TABLE user_feature_grants
  ADD CONSTRAINT user_feature_grants_grant_source_check CHECK (grant_source IN ('manual', 'org_rule'));

CREATE INDEX IF NOT EXISTS user_feature_grants_source_idx ON user_feature_grants (grant_source, grant_source_ref);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ec_org_units (
  dept_id BIGINT PRIMARY KEY,
  dept_name TEXT NOT NULL,
  parent_dept_id BIGINT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ec_org_members (
  ec_user_id TEXT PRIMARY KEY,
  dept_id BIGINT REFERENCES ec_org_units(dept_id) ON DELETE SET NULL,
  user_name TEXT NOT NULL,
  title TEXT,
  account TEXT,
  status INTEGER NOT NULL DEFAULT 0,
  local_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  raw_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ec_org_grant_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dept_id BIGINT NOT NULL REFERENCES ec_org_units(dept_id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dept_id, project_key, feature_key)
);

CREATE INDEX IF NOT EXISTS ec_org_grant_rules_dept_idx ON ec_org_grant_rules (dept_id);

CREATE INDEX IF NOT EXISTS ec_org_members_dept_id_idx ON ec_org_members (dept_id);
CREATE INDEX IF NOT EXISTS ec_org_members_local_user_id_idx ON ec_org_members (local_user_id);
CREATE INDEX IF NOT EXISTS ec_org_members_account_idx ON ec_org_members (account);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS ec_identities_set_updated_at ON ec_identities;
CREATE TRIGGER ec_identities_set_updated_at
BEFORE UPDATE ON ec_identities
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS features_set_updated_at ON features;
CREATE TRIGGER features_set_updated_at
BEFORE UPDATE ON features
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS ec_org_units_set_updated_at ON ec_org_units;
CREATE TRIGGER ec_org_units_set_updated_at
BEFORE UPDATE ON ec_org_units
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS ec_org_members_set_updated_at ON ec_org_members;
CREATE TRIGGER ec_org_members_set_updated_at
BEFORE UPDATE ON ec_org_members
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS ec_org_grant_rules_set_updated_at ON ec_org_grant_rules;
CREATE TRIGGER ec_org_grant_rules_set_updated_at
BEFORE UPDATE ON ec_org_grant_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO users (ec_user_id, display_name, status, is_admin, provision_source, review_note, approved_at)
VALUES ('REDACTED_ADMIN_ID', 'Admin', 'active', TRUE, 'first_login', 'Preconfigured admin', NOW())
ON CONFLICT (ec_user_id) WHERE ec_user_id IS NOT NULL DO NOTHING;