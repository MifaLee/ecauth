export type UserStatus = 'pending_review' | 'active' | 'rejected' | 'disabled';

export interface UserRecord {
  id: string;
  ec_user_id: string | null;
  ec_employee_id: string | null;
  ec_dept_id: string | null;
  ec_title: string | null;
  email: string | null;
  mobile: string | null;
  display_name: string;
  status: UserStatus;
  is_admin: boolean;
  provision_source: 'first_login' | 'org_sync';
  review_note: string | null;
  approved_by: string | null;
  approved_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionClaims {
  sub: string;
  status: UserStatus;
  isAdmin: boolean;
  type: 'session';
}

export interface EcIdentityProfile {
  providerUserId: string;
  employeeId: string | null;
  departmentId: string | null;
  title: string | null;
  email: string | null;
  mobile: string | null;
  displayName: string;
  rawProfile: Record<string, unknown>;
}

export interface EcOrgUnitRecord {
  dept_id: string;
  dept_name: string;
  parent_dept_id: string | null;
  is_active: boolean;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface EcOrgMemberRecord {
  ec_user_id: string;
  dept_id: string | null;
  user_name: string;
  title: string | null;
  account: string | null;
  status: number;
  local_user_id: string | null;
  raw_profile: Record<string, unknown>;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface EcOrgGrantRuleRecord {
  id: string;
  dept_id: string;
  project_key: string;
  feature_key: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeatureGrantInput {
  projectKey: string;
  featureKey: string;
}

export interface ProjectManifestFeatureInput {
  key: string;
  name: string;
  description?: string;
}

export interface ProjectManifestInput {
  projectKey: string;
  name: string;
  description?: string;
  features: ProjectManifestFeatureInput[];
}

export interface AccessProfile {
  isAdmin: boolean;
  projects: Array<{
    projectKey: string;
    projectName: string;
    features: Array<{
      featureKey: string;
      featureName: string;
    }>;
  }>;
}