import type { PoolClient, QueryResultRow } from 'pg';
import { serverConfig } from '../lib/config';
import { query, withTransaction } from '../lib/db';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import type { AccessProfile, EcIdentityProfile, FeatureGrantInput, UserRecord, UserStatus } from '../lib/models';
import { recordAuditLog } from './audit-service';
import { listProjectCatalog, listProjectFeatureKeys } from './project-service';

interface UserPermissionRow extends QueryResultRow {
  user_id: string;
  project_key: string;
  project_name: string;
  feature_key: string;
  feature_name: string;
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

function mapUser(user: UserRecord) {
  return {
    id: user.id,
    ecUserId: user.ec_user_id,
    employeeId: user.ec_employee_id,
    ecDeptId: user.ec_dept_id,
    ecTitle: user.ec_title,
    email: user.email,
    mobile: user.mobile,
    displayName: user.display_name,
    status: user.status,
    isAdmin: user.is_admin,
    provisionSource: user.provision_source,
    reviewNote: user.review_note,
    approvedAt: user.approved_at,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

function isBootstrapAdmin(profile: EcIdentityProfile): boolean {
  const candidates = [profile.providerUserId, profile.employeeId, profile.email, profile.mobile]
    .map((value) => normalizeIdentifier(value))
    .filter((value): value is string => Boolean(value));

  return candidates.some((value) => serverConfig.platformAdminIdentifiers.includes(value));
}

function groupPermissionRows(rows: UserPermissionRow[]): AccessProfile {
  const projects = new Map<string, AccessProfile['projects'][number]>();

  for (const row of rows) {
    if (!projects.has(row.project_key)) {
      projects.set(row.project_key, {
        projectKey: row.project_key,
        projectName: row.project_name,
        features: [],
      });
    }

    projects.get(row.project_key)?.features.push({
      featureKey: row.feature_key,
      featureName: row.feature_name,
    });
  }

  return {
    isAdmin: false,
    projects: [...projects.values()],
  };
}

async function buildDeptPathMap(): Promise<Map<string, string>> {
  const units = await query<{ dept_id: string; dept_name: string; parent_dept_id: string | null }>(
    `SELECT dept_id::text, dept_name, parent_dept_id::text FROM ec_org_units WHERE is_active = TRUE`,
  );
  const unitMap = new Map<string, { name: string; parentId: string | null }>();
  for (const u of units.rows) {
    unitMap.set(u.dept_id, { name: u.dept_name, parentId: u.parent_dept_id });
  }

  function resolvePath(deptId: string): string {
    const parts: string[] = [];
    let current: string | null = deptId;
    const visited = new Set<string>();
    while (current && unitMap.has(current) && !visited.has(current)) {
      visited.add(current);
      const unit: { name: string; parentId: string | null } = unitMap.get(current)!;
      parts.unshift(unit.name);
      current = unit.parentId;
    }
    return parts.join('/');
  }

  const pathMap = new Map<string, string>();
  for (const [deptId] of unitMap) {
    pathMap.set(deptId, resolvePath(deptId));
  }
  return pathMap;
}

async function findUserByEcIdentity(client: PoolClient, providerUserId: string): Promise<UserRecord | null> {
  const result = await client.query<UserRecord>(
    `
      SELECT u.*
      FROM users u
      JOIN ec_identities ei ON ei.user_id = u.id
      WHERE ei.provider = 'ec' AND ei.provider_user_id = $1
      LIMIT 1
    `,
    [providerUserId],
  );

  return result.rows[0] ?? null;
}

async function findMatchingUser(client: PoolClient, profile: EcIdentityProfile): Promise<UserRecord | null> {
  const conditions: string[] = [];
  const params: string[] = [];

  if (profile.providerUserId) {
    params.push(profile.providerUserId);
    conditions.push(`ec_user_id = $${params.length}`);
  }

  if (profile.employeeId) {
    params.push(profile.employeeId);
    conditions.push(`ec_employee_id = $${params.length}`);
  }
  if (profile.email) {
    params.push(profile.email.toLowerCase());
    conditions.push(`LOWER(email) = $${params.length}`);
  }
  if (profile.mobile) {
    params.push(profile.mobile);
    conditions.push(`mobile = $${params.length}`);
  }

  if (conditions.length === 0) {
    return null;
  }

  const result = await client.query<UserRecord>(
    `
      SELECT *
      FROM users
      WHERE ${conditions.join(' OR ')}
      ORDER BY created_at ASC
      LIMIT 1
    `,
    params,
  );

  return result.rows[0] ?? null;
}

async function upsertEcIdentity(client: PoolClient, userId: string, profile: EcIdentityProfile): Promise<void> {
  await client.query(
    `
      INSERT INTO ec_identities (provider, provider_user_id, user_id, email, mobile, raw_profile, last_login_at)
      VALUES ('ec', $1, $2, $3, $4, $5::jsonb, NOW())
      ON CONFLICT (provider, provider_user_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        email = EXCLUDED.email,
        mobile = EXCLUDED.mobile,
        raw_profile = EXCLUDED.raw_profile,
        last_login_at = NOW(),
        updated_at = NOW()
    `,
    [profile.providerUserId, userId, profile.email?.toLowerCase() ?? null, profile.mobile, JSON.stringify(profile.rawProfile)],
  );
}

async function listUserPermissionRows(userId: string): Promise<UserPermissionRow[]> {
  const result = await query<UserPermissionRow>(
    `
      SELECT
        ug.user_id,
        p.project_key,
        p.name AS project_name,
        f.feature_key,
        f.name AS feature_name
      FROM user_feature_grants ug
      JOIN features f ON f.id = ug.feature_id
      JOIN projects p ON p.id = f.project_id
      WHERE ug.user_id = $1 AND p.status = 'active' AND f.status = 'active'
      ORDER BY p.project_key, f.feature_key
    `,
    [userId],
  );

  return result.rows;
}

export async function getUserById(userId: string): Promise<UserRecord | null> {
  const result = await query<UserRecord>('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
  return result.rows[0] ?? null;
}

export async function syncUserFromEcLogin(profile: EcIdentityProfile): Promise<UserRecord> {
  return withTransaction(async (client) => {
    let user = await findUserByEcIdentity(client, profile.providerUserId);
    if (!user) {
      user = await findMatchingUser(client, profile);
    }

    const bootstrapAdmin = isBootstrapAdmin(profile);

    if (!user) {
      const status: UserStatus = bootstrapAdmin ? 'active' : 'pending_review';
      const created = await client.query<UserRecord>(
        `
          INSERT INTO users (
            ec_user_id,
            ec_employee_id,
            ec_dept_id,
            ec_title,
            email,
            mobile,
            display_name,
            status,
            is_admin,
            provision_source,
            review_note,
            approved_at,
            last_login_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
          RETURNING *
        `,
        [
          profile.providerUserId,
          profile.employeeId,
          profile.departmentId,
          profile.title,
          profile.email?.toLowerCase() ?? null,
          profile.mobile,
          profile.displayName,
          status,
          bootstrapAdmin,
          'first_login',
          bootstrapAdmin ? 'Bootstrap admin from PLATFORM_ADMIN_IDENTIFIERS' : null,
          bootstrapAdmin ? new Date().toISOString() : null,
        ],
      );
      user = created.rows[0];
    } else {
      const status: UserStatus = bootstrapAdmin ? 'active' : user.status;
      const updated = await client.query<UserRecord>(
        `
          UPDATE users
          SET
            ec_user_id = COALESCE($2, ec_user_id),
            ec_employee_id = COALESCE($3, ec_employee_id),
            ec_dept_id = COALESCE($4, ec_dept_id),
            ec_title = COALESCE($5, ec_title),
            email = COALESCE($6, email),
            mobile = COALESCE($7, mobile),
            display_name = $8,
            status = $9,
            is_admin = $10,
            provision_source = CASE
              WHEN provision_source = 'org_sync' THEN provision_source
              ELSE 'first_login'
            END,
            review_note = CASE
              WHEN $10 = TRUE AND review_note IS NULL THEN 'Bootstrap admin from PLATFORM_ADMIN_IDENTIFIERS'
              ELSE review_note
            END,
            approved_at = CASE
              WHEN $9 = 'active' THEN COALESCE(approved_at, NOW())
              ELSE approved_at
            END,
            last_login_at = NOW(),
            updated_at = NOW()
            WHERE id = $1
            RETURNING *
          `,
          [
            user.id,
            profile.providerUserId,
            profile.employeeId,
            profile.departmentId,
            profile.title,
            profile.email?.toLowerCase() ?? null,
            profile.mobile,
            profile.displayName,
            status,
            bootstrapAdmin ? true : user.is_admin,
          ],
        );
        user = updated.rows[0];
      }

      if (user.provision_source === 'org_sync' && user.status === 'active' && !user.approved_at) {
        const approved = await client.query<UserRecord>(
          `
            UPDATE users
            SET approved_at = NOW(), updated_at = NOW()
            WHERE id = $1
            RETURNING *
          `,
          [user.id],
        );
        user = approved.rows[0] ?? user;
      }

      await upsertEcIdentity(client, user.id, profile);
      await linkOrgMemberToUser({ ecUserId: profile.providerUserId, userId: user.id, client });
      await recordAuditLog({
        client,
        actorUserId: user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        detail: { provider: 'ec', status: user.status, provisionSource: user.provision_source },
      });

      return user;
    });
  }

export async function linkOrgMemberToUser(params: {
  ecUserId: string;
  userId: string;
  client?: PoolClient;
}): Promise<void> {
  const sql = `
    UPDATE ec_org_members
    SET local_user_id = $2, updated_at = NOW()
    WHERE ec_user_id = $1
  `;

  if (params.client) {
    await params.client.query(sql, [params.ecUserId, params.userId]);
    return;
  }

  await query(sql, [params.ecUserId, params.userId]);
}

export async function getAccessProfileForUser(user: UserRecord): Promise<AccessProfile> {
  if (user.is_admin) {
    return {
      isAdmin: true,
      projects: await listProjectCatalog(),
    };
  }

  return groupPermissionRows(await listUserPermissionRows(user.id));
}

export async function listUsersWithPermissions(filters?: {
  keyword?: string;
  status?: UserStatus;
  isAdmin?: boolean;
}): Promise<Array<ReturnType<typeof mapUser> & { deptPath: string; permissions: AccessProfile }>> {
  const conditions: string[] = [];
  const params: Array<string | boolean> = [];

  if (filters?.keyword) {
    params.push(`%${filters.keyword.trim().toLowerCase()}%`);
    const placeholder = `$${params.length}`;
    conditions.push(`(
      LOWER(display_name) LIKE ${placeholder}
      OR LOWER(COALESCE(email, '')) LIKE ${placeholder}
      OR LOWER(COALESCE(mobile, '')) LIKE ${placeholder}
      OR LOWER(COALESCE(ec_employee_id, '')) LIKE ${placeholder}
      OR LOWER(COALESCE(ec_user_id, '')) LIKE ${placeholder}
      OR LOWER(COALESCE(ec_title, '')) LIKE ${placeholder}
    )`);
  }

  if (filters?.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }

  if (typeof filters?.isAdmin === 'boolean') {
    params.push(filters.isAdmin);
    conditions.push(`is_admin = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const usersResult = await query<UserRecord>(`SELECT * FROM users ${whereClause} ORDER BY created_at DESC`, params);
  const permissionResult = await query<UserPermissionRow>(
    `
      SELECT
        ug.user_id,
        p.project_key,
        p.name AS project_name,
        f.feature_key,
        f.name AS feature_name
      FROM user_feature_grants ug
      JOIN features f ON f.id = ug.feature_id
      JOIN projects p ON p.id = f.project_id
      WHERE p.status = 'active' AND f.status = 'active'
      ORDER BY ug.user_id, p.project_key, f.feature_key
    `,
  );

  const grouped = new Map<string, UserPermissionRow[]>();
  for (const row of permissionResult.rows) {
    const entries = grouped.get(row.user_id) ?? [];
    entries.push(row);
    grouped.set(row.user_id, entries);
  }

  const adminCatalog = await listProjectCatalog();
  const deptPathMap = await buildDeptPathMap();
  return usersResult.rows.map((user) => ({
    ...mapUser(user),
    deptPath: user.ec_dept_id ? (deptPathMap.get(String(user.ec_dept_id)) ?? '') : '',
    permissions: user.is_admin ? { isAdmin: true, projects: adminCatalog } : groupPermissionRows(grouped.get(user.id) ?? []),
  }));
}

export async function reviewUser(params: {
  userId: string;
  action: 'approve' | 'reject' | 'disable';
  note?: string;
  reviewerId: string;
}): Promise<UserRecord> {
  const statusMap: Record<typeof params.action, UserStatus> = {
    approve: 'active',
    reject: 'rejected',
    disable: 'disabled',
  };

  return withTransaction(async (client) => {
    const result = await client.query<UserRecord>(
      `
        UPDATE users
        SET
          status = $2,
          review_note = $3,
          approved_by = CASE WHEN $2 = 'active' THEN $4 ELSE approved_by END,
          approved_at = CASE WHEN $2 = 'active' THEN NOW() ELSE approved_at END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [params.userId, statusMap[params.action], params.note ?? null, params.reviewerId],
    );

    const user = result.rows[0];
    if (!user) {
      throw new NotFoundError(`User not found: ${params.userId}`);
    }

    await recordAuditLog({
      client,
      actorUserId: params.reviewerId,
      action: `user.review.${params.action}`,
      targetType: 'user',
      targetId: user.id,
      detail: { note: params.note ?? null },
    });

    return user;
  });
}

export async function reviewUsersBatch(params: {
  userIds: string[];
  action: 'approve' | 'reject' | 'disable';
  note?: string;
  reviewerId: string;
}): Promise<{ updatedCount: number }> {
  if (params.userIds.length === 0) {
    throw new ValidationError('userIds must not be empty');
  }

  await withTransaction(async (client) => {
    for (const userId of params.userIds) {
      const result = await client.query<UserRecord>(
        `
          UPDATE users
          SET
            status = $2,
            review_note = $3,
            approved_by = CASE WHEN $2 = 'active' THEN $4 ELSE approved_by END,
            approved_at = CASE WHEN $2 = 'active' THEN NOW() ELSE approved_at END,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          userId,
          params.action === 'approve' ? 'active' : params.action === 'reject' ? 'rejected' : 'disabled',
          params.note ?? null,
          params.reviewerId,
        ],
      );

      if (!result.rows[0]) {
        throw new NotFoundError(`User not found: ${userId}`);
      }

      await recordAuditLog({
        client,
        actorUserId: params.reviewerId,
        action: `user.review.${params.action}`,
        targetType: 'user',
        targetId: userId,
        detail: { note: params.note ?? null, batch: true },
      });
    }
  });

  return { updatedCount: params.userIds.length };
}

export async function setUserAdmin(params: { userId: string; isAdmin: boolean; actorUserId: string }): Promise<UserRecord> {
  return withTransaction(async (client) => {
    const result = await client.query<UserRecord>(
      `
        UPDATE users
        SET is_admin = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [params.userId, params.isAdmin],
    );

    const user = result.rows[0];
    if (!user) {
      throw new NotFoundError(`User not found: ${params.userId}`);
    }

    await recordAuditLog({
      client,
      actorUserId: params.actorUserId,
      action: params.isAdmin ? 'user.admin.grant' : 'user.admin.revoke',
      targetType: 'user',
      targetId: user.id,
    });

    return user;
  });
}

async function resolveFeatureIds(client: PoolClient, grants: FeatureGrantInput[]): Promise<string[]> {
  const featureIds: string[] = [];
  for (const grant of grants) {
    const result = await client.query<{ id: string }>(
      `
        SELECT f.id
        FROM features f
        JOIN projects p ON p.id = f.project_id
        WHERE p.project_key = $1 AND f.feature_key = $2 AND p.status = 'active' AND f.status = 'active'
        LIMIT 1
      `,
      [grant.projectKey, grant.featureKey],
    );

    if (!result.rows[0]) {
      throw new NotFoundError(`Feature not found: ${grant.projectKey}/${grant.featureKey}`);
    }

    featureIds.push(result.rows[0].id);
  }

  return featureIds;
}

export async function grantFeatures(params: {
  userId: string;
  grants: FeatureGrantInput[];
  actorUserId?: string;
  grantSource?: 'manual' | 'org_rule';
  grantSourceRef?: string;
}): Promise<AccessProfile> {
  if (params.grants.length === 0) {
    throw new ValidationError('grants must not be empty');
  }

  return withTransaction(async (client) => {
    const userResult = await client.query<UserRecord>('SELECT * FROM users WHERE id = $1 LIMIT 1', [params.userId]);
    const user = userResult.rows[0];
    if (!user) {
      throw new NotFoundError(`User not found: ${params.userId}`);
    }

    const featureIds = await resolveFeatureIds(client, params.grants);
    for (const featureId of featureIds) {
      await client.query(
        `
          INSERT INTO user_feature_grants (user_id, feature_id, granted_by, grant_source, grant_source_ref)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (user_id, feature_id) DO NOTHING
        `,
        [params.userId, featureId, params.actorUserId ?? null, params.grantSource ?? 'manual', params.grantSourceRef ?? null],
      );
    }

    await recordAuditLog({
      client,
      actorUserId: params.actorUserId,
      action: 'user.permissions.grant',
      targetType: 'user',
      targetId: params.userId,
      detail: params.grants,
    });

    return getAccessProfileForUser(user);
  });
}

export async function grantFeaturesBatch(params: {
  userIds: string[];
  grants: FeatureGrantInput[];
  actorUserId?: string;
  grantSource?: 'manual' | 'org_rule';
  grantSourceRef?: string;
}): Promise<{ updatedCount: number }> {
  if (params.userIds.length === 0) {
    throw new ValidationError('userIds must not be empty');
  }
  if (params.grants.length === 0) {
    throw new ValidationError('grants must not be empty');
  }

  await withTransaction(async (client) => {
    const featureIds = await resolveFeatureIds(client, params.grants);
    for (const userId of params.userIds) {
      const userResult = await client.query<UserRecord>('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
      if (!userResult.rows[0]) {
        throw new NotFoundError(`User not found: ${userId}`);
      }

      for (const featureId of featureIds) {
        await client.query(
          `
            INSERT INTO user_feature_grants (user_id, feature_id, granted_by, grant_source, grant_source_ref)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id, feature_id) DO NOTHING
          `,
          [userId, featureId, params.actorUserId ?? null, params.grantSource ?? 'manual', params.grantSourceRef ?? null],
        );
      }

      await recordAuditLog({
        client,
        actorUserId: params.actorUserId,
        action: 'user.permissions.grant',
        targetType: 'user',
        targetId: userId,
        detail: { grants: params.grants, batch: true },
      });
    }
  });

  return { updatedCount: params.userIds.length };
}

export async function revokeFeatures(params: {
  userId: string;
  grants: FeatureGrantInput[];
  actorUserId: string;
}): Promise<AccessProfile> {
  if (params.grants.length === 0) {
    throw new ValidationError('grants must not be empty');
  }

  return withTransaction(async (client) => {
    const userResult = await client.query<UserRecord>('SELECT * FROM users WHERE id = $1 LIMIT 1', [params.userId]);
    const user = userResult.rows[0];
    if (!user) {
      throw new NotFoundError(`User not found: ${params.userId}`);
    }

    const featureIds = await resolveFeatureIds(client, params.grants);
    for (const featureId of featureIds) {
      await client.query('DELETE FROM user_feature_grants WHERE user_id = $1 AND feature_id = $2', [params.userId, featureId]);
    }

    await recordAuditLog({
      client,
      actorUserId: params.actorUserId,
      action: 'user.permissions.revoke',
      targetType: 'user',
      targetId: params.userId,
      detail: params.grants,
    });

    return getAccessProfileForUser(user);
  });
}

export async function revokeFeaturesBatch(params: {
  userIds: string[];
  grants: FeatureGrantInput[];
  actorUserId: string;
}): Promise<{ updatedCount: number }> {
  if (params.userIds.length === 0) {
    throw new ValidationError('userIds must not be empty');
  }
  if (params.grants.length === 0) {
    throw new ValidationError('grants must not be empty');
  }

  await withTransaction(async (client) => {
    const featureIds = await resolveFeatureIds(client, params.grants);
    for (const userId of params.userIds) {
      const userResult = await client.query<UserRecord>('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
      if (!userResult.rows[0]) {
        throw new NotFoundError(`User not found: ${userId}`);
      }

      for (const featureId of featureIds) {
        await client.query('DELETE FROM user_feature_grants WHERE user_id = $1 AND feature_id = $2', [userId, featureId]);
      }

      await recordAuditLog({
        client,
        actorUserId: params.actorUserId,
        action: 'user.permissions.revoke',
        targetType: 'user',
        targetId: userId,
        detail: { grants: params.grants, batch: true },
      });
    }
  });

  return { updatedCount: params.userIds.length };
}

export async function hasFeatureAccess(user: UserRecord, projectKey: string, featureKey: string): Promise<boolean> {
  if (user.status !== 'active') {
    return false;
  }

  if (user.is_admin) {
    try {
      const featureKeys = await listProjectFeatureKeys(projectKey);
      return featureKeys.includes(featureKey);
    } catch {
      return false;
    }
  }

  const result = await query<{ allowed: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM user_feature_grants ug
        JOIN features f ON f.id = ug.feature_id
        JOIN projects p ON p.id = f.project_id
        WHERE ug.user_id = $1 AND p.project_key = $2 AND f.feature_key = $3
      ) AS allowed
    `,
    [user.id, projectKey, featureKey],
  );

  return Boolean(result.rows[0]?.allowed);
}

export async function getProjectFeaturesForUser(user: UserRecord, projectKey: string): Promise<string[]> {
  if (user.status !== 'active') {
    throw new ForbiddenError('Only approved users can request project tokens');
  }

  if (user.is_admin) {
    return listProjectFeatureKeys(projectKey);
  }

  const result = await query<{ feature_key: string }>(
    `
      SELECT f.feature_key
      FROM user_feature_grants ug
      JOIN features f ON f.id = ug.feature_id
      JOIN projects p ON p.id = f.project_id
      WHERE ug.user_id = $1 AND p.project_key = $2 AND p.status = 'active' AND f.status = 'active'
      ORDER BY f.feature_key
    `,
    [user.id, projectKey],
  );

  if (result.rowCount === 0) {
    throw new ForbiddenError(`User has no access to project: ${projectKey}`);
  }

  return result.rows.map((row) => row.feature_key);
}

export function toPublicUser(user: UserRecord) {
  return mapUser(user);
}