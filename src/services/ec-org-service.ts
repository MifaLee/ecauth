import { createHash } from 'crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { serverConfig } from '../lib/config';
import { query, withTransaction } from '../lib/db';
import { ValidationError } from '../lib/errors';
import type { AccessProfile, EcOrgGrantRuleRecord, EcOrgMemberRecord, EcOrgUnitRecord, FeatureGrantInput, UserRecord, UserStatus } from '../lib/models';
import { recordAuditLog } from './audit-service';
import { getAccessProfileForUser, grantFeaturesBatch, linkOrgMemberToUser } from './user-service';

interface EcOrgApiDept {
  deptId: number;
  deptName: string;
  parentDeptId: number;
}

interface EcOrgApiUser {
  userId: number;
  userName: string;
  deptId: number;
  title?: string;
  status?: number;
  account?: string;
}

interface OrgMemberRow extends QueryResultRow {
  ec_user_id: string;
  dept_id: string | null;
  user_name: string;
  title: string | null;
  account: string | null;
  status: number;
  local_user_id: string | null;
  synced_at: string;
  dept_name: string | null;
  parent_dept_id: string | null;
}

interface OrgGrantRuleRow extends QueryResultRow {
  id: string;
  dept_id: string;
  project_key: string;
  feature_key: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  dept_name: string;
}

interface FeatureIdRow extends QueryResultRow {
  id: string;
  project_key: string;
  feature_key: string;
}

const DEFAULT_ADMIN_EC_USER_IDS = new Set(['REDACTED_ADMIN_ID']);

function requireEcOpenApiConfig(): void {
  if (!serverConfig.ecOpenCorpId || !serverConfig.ecOpenAppId || !serverConfig.ecOpenAppSecret) {
    throw new ValidationError('EC open API credentials are not configured');
  }
}

function buildEcOpenApiHeaders(): Record<string, string> {
  requireEcOpenApiConfig();
  const timeStamp = Date.now().toString();
  const source = `appId=${serverConfig.ecOpenAppId}&appSecret=${serverConfig.ecOpenAppSecret}&timeStamp=${timeStamp}`;
  const sign = createHash('md5').update(source, 'utf8').digest('hex').toUpperCase();
  return {
    'Content-Type': 'application/json',
    'X-Ec-Cid': serverConfig.ecOpenCorpId,
    'X-Ec-Sign': sign,
    'X-Ec-TimeStamp': timeStamp,
  };
}

async function fetchEcOrgStructure(): Promise<{ depts: EcOrgApiDept[]; users: EcOrgApiUser[] }> {
  const url = new URL('/v2/org/struct/info', serverConfig.ecOpenApiBaseUrl);
  url.searchParams.set('needUser', 'true');
  const response = await fetch(url, { method: 'GET', headers: buildEcOpenApiHeaders() });
  const payload = await response.json() as {
    code?: number;
    msg?: string;
    data?: { depts?: EcOrgApiDept[]; users?: EcOrgApiUser[] };
  };

  if (!response.ok || payload.code !== 200 || !payload.data) {
    throw new ValidationError(payload.msg || 'Failed to fetch EC organization structure');
  }

  return {
    depts: Array.isArray(payload.data.depts) ? payload.data.depts : [],
    users: Array.isArray(payload.data.users) ? payload.data.users : [],
  };
}

function mapOrgSummary(user: UserRecord) {
  return {
    id: user.id,
    displayName: user.display_name,
    mobile: user.mobile,
    status: user.status,
    isAdmin: user.is_admin,
    provisionSource: user.provision_source,
  };
}

async function findLocalUserForOrgMember(client: PoolClient, member: EcOrgApiUser): Promise<UserRecord | null> {
  const result = await client.query<UserRecord>(
    `
      SELECT *
      FROM users
      WHERE ec_user_id = $1
        OR ($2::text IS NOT NULL AND mobile = $2)
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [String(member.userId), member.account?.trim() || null],
  );

  return result.rows[0] ?? null;
}

async function upsertOrgProvisionedUser(client: PoolClient, member: EcOrgApiUser): Promise<{ user: UserRecord; created: boolean }> {
  const existing = await findLocalUserForOrgMember(client, member);
  const ecUserId = String(member.userId);
  const isBootstrap = serverConfig.platformAdminIdentifiers.includes(ecUserId.toLowerCase());
  const isDefaultAdmin = DEFAULT_ADMIN_EC_USER_IDS.has(ecUserId);
  const isAdmin = isBootstrap || isDefaultAdmin;
  const nextStatus: UserStatus = isAdmin ? 'active' : (Number(member.status) === 1 ? 'disabled' : 'active');
  const reviewNote = 'Provisioned from EC organization sync';
  if (!existing) {
    const created = await client.query<UserRecord>(
      `
        INSERT INTO users (
          ec_user_id,
          ec_dept_id,
          ec_title,
          mobile,
          display_name,
          status,
          is_admin,
          provision_source,
          review_note,
          approved_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'org_sync', $8, CASE WHEN $6 = 'active' THEN NOW() ELSE NULL END)
        RETURNING *
      `,
      [ecUserId, member.deptId || null, member.title?.trim() || null, member.account?.trim() || null, member.userName.trim(), nextStatus, isAdmin, reviewNote],
    );
    return { user: created.rows[0], created: true };
  }

  const updated = await client.query<UserRecord>(
    `
      UPDATE users
      SET
        ec_user_id = COALESCE($2, ec_user_id),
        ec_dept_id = COALESCE($3, ec_dept_id),
        ec_title = COALESCE($4, ec_title),
        mobile = COALESCE($5, mobile),
        display_name = $6,
        status = CASE WHEN is_admin = TRUE AND status = 'active' THEN status ELSE $7 END,
        is_admin = $9,
        provision_source = 'org_sync',
        review_note = CASE WHEN review_note IS NULL THEN $8 ELSE review_note END,
        approved_at = CASE
          WHEN $7 = 'active' THEN COALESCE(approved_at, NOW())
          ELSE approved_at
        END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [existing.id, ecUserId, member.deptId || null, member.title?.trim() || null, member.account?.trim() || null, member.userName.trim(), nextStatus, reviewNote, isAdmin],
  );

  return { user: updated.rows[0], created: false };
}

async function resolveFeatureRows(client: PoolClient, grants: FeatureGrantInput[]): Promise<FeatureIdRow[]> {
  const rows: FeatureIdRow[] = [];
  for (const grant of grants) {
    const result = await client.query<FeatureIdRow>(
      `
        SELECT f.id, p.project_key, f.feature_key
        FROM features f
        JOIN projects p ON p.id = f.project_id
        WHERE p.project_key = $1 AND f.feature_key = $2 AND p.status = 'active' AND f.status = 'active'
        LIMIT 1
      `,
      [grant.projectKey, grant.featureKey],
    );

    if (!result.rows[0]) {
      throw new ValidationError(`Feature not found: ${grant.projectKey}/${grant.featureKey}`);
    }

    rows.push(result.rows[0]);
  }

  return rows;
}

async function applyOrgGrantRulesForDeptIds(client: PoolClient, deptIds: string[], actorUserId?: string): Promise<void> {
  if (!deptIds.length) {
    return;
  }

  const rulesResult = await client.query<OrgGrantRuleRow>(
    `
      SELECT id, dept_id::text, project_key, feature_key, created_by, created_at, updated_at, '' AS dept_name
      FROM ec_org_grant_rules
      WHERE dept_id::text = ANY($1::text[])
      ORDER BY dept_id, project_key, feature_key
    `,
    [deptIds],
  );

  const rulesByDept = new Map<string, FeatureGrantInput[]>();
  for (const row of rulesResult.rows) {
    const items = rulesByDept.get(row.dept_id) ?? [];
    items.push({ projectKey: row.project_key, featureKey: row.feature_key });
    rulesByDept.set(row.dept_id, items);
  }

  for (const deptId of deptIds) {
    const grants = rulesByDept.get(deptId) ?? [];
    if (!grants.length) {
      continue;
    }

    const membersResult = await client.query<{ local_user_id: string | null }>(
      `
        SELECT local_user_id
        FROM ec_org_members
        WHERE dept_id::text = $1 AND local_user_id IS NOT NULL
      `,
      [deptId],
    );
    const userIds = membersResult.rows.map((row) => row.local_user_id).filter((value): value is string => Boolean(value));
    if (!userIds.length) {
      continue;
    }

    await grantFeaturesBatch({
      userIds,
      grants,
      actorUserId,
      grantSource: 'org_rule',
      grantSourceRef: deptId,
    });
  }
}

export async function syncEcOrganization(actorUserId?: string): Promise<{
  syncedAt: string;
  unitCount: number;
  memberCount: number;
  createdUsers: number;
  updatedUsers: number;
}> {
  const structure = await fetchEcOrgStructure();
  const syncedAt = new Date().toISOString();

  return withTransaction(async (client) => {
    const deptIds = new Set(structure.depts.map((dept) => String(dept.deptId)));
    await client.query('UPDATE ec_org_units SET is_active = FALSE WHERE dept_id::text <> ALL($1::text[])', [[...deptIds]]);

    for (const dept of structure.depts) {
      await client.query(
        `
          INSERT INTO ec_org_units (dept_id, dept_name, parent_dept_id, is_active, synced_at)
          VALUES ($1, $2, $3, TRUE, $4)
          ON CONFLICT (dept_id)
          DO UPDATE SET
            dept_name = EXCLUDED.dept_name,
            parent_dept_id = EXCLUDED.parent_dept_id,
            is_active = TRUE,
            synced_at = EXCLUDED.synced_at,
            updated_at = NOW()
        `,
        [dept.deptId, dept.deptName.trim(), dept.parentDeptId || null, syncedAt],
      );
    }

    let createdUsers = 0;
    let updatedUsers = 0;

    for (const member of structure.users) {
      const provisioned = await upsertOrgProvisionedUser(client, member);
      if (provisioned.created) {
        createdUsers += 1;
      } else {
        updatedUsers += 1;
      }

      await client.query(
        `
          INSERT INTO ec_org_members (ec_user_id, dept_id, user_name, title, account, status, local_user_id, raw_profile, synced_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
          ON CONFLICT (ec_user_id)
          DO UPDATE SET
            dept_id = EXCLUDED.dept_id,
            user_name = EXCLUDED.user_name,
            title = EXCLUDED.title,
            account = EXCLUDED.account,
            status = EXCLUDED.status,
            local_user_id = EXCLUDED.local_user_id,
            raw_profile = EXCLUDED.raw_profile,
            synced_at = EXCLUDED.synced_at,
            updated_at = NOW()
        `,
        [
          String(member.userId),
          member.deptId || null,
          member.userName.trim(),
          member.title?.trim() || null,
          member.account?.trim() || null,
          Number(member.status ?? 0),
          provisioned.user.id,
          JSON.stringify(member),
          syncedAt,
        ],
      );

      await linkOrgMemberToUser({ ecUserId: String(member.userId), userId: provisioned.user.id, client });
    }

    await recordAuditLog({
      client,
      actorUserId,
      action: 'org.sync',
      targetType: 'org',
      targetId: serverConfig.ecOpenCorpId || 'ec',
      detail: { syncedAt, unitCount: structure.depts.length, memberCount: structure.users.length, createdUsers, updatedUsers },
    });

    return {
      syncedAt,
      unitCount: structure.depts.length,
      memberCount: structure.users.length,
      createdUsers,
      updatedUsers,
    };
  });
}

export async function listEcOrgUnits(): Promise<Array<EcOrgUnitRecord & { member_count: number }>> {
  const result = await query<EcOrgUnitRecord & { member_count: number }>(
    `
      SELECT
        u.*, 
        COUNT(m.ec_user_id)::int AS member_count
      FROM ec_org_units u
      LEFT JOIN ec_org_members m ON m.dept_id = u.dept_id
      GROUP BY u.dept_id
      ORDER BY u.parent_dept_id NULLS FIRST, u.dept_name ASC
    `,
  );
  return result.rows;
}

export async function listEcOrgMembers(filters?: {
  keyword?: string;
  deptId?: string;
  status?: number;
}): Promise<Array<{
  ecUserId: string;
  deptId: string | null;
  deptName: string | null;
  parentDeptId: string | null;
  userName: string;
  title: string | null;
  account: string | null;
  status: number;
  syncedAt: string;
  user: ReturnType<typeof mapOrgSummary> | null;
  permissions: AccessProfile | null;
}>> {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filters?.keyword) {
    params.push(`%${filters.keyword.trim().toLowerCase()}%`);
    const placeholder = `$${params.length}`;
    conditions.push(`(
      LOWER(m.user_name) LIKE ${placeholder}
      OR LOWER(COALESCE(m.title, '')) LIKE ${placeholder}
      OR LOWER(COALESCE(m.account, '')) LIKE ${placeholder}
      OR LOWER(m.ec_user_id) LIKE ${placeholder}
    )`);
  }
  if (filters?.deptId) {
    params.push(filters.deptId);
    conditions.push(`m.dept_id::text = $${params.length}`);
  }
  if (typeof filters?.status === 'number') {
    params.push(filters.status);
    conditions.push(`m.status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query<OrgMemberRow>(
    `
      SELECT
        m.ec_user_id,
        m.dept_id::text,
        m.user_name,
        m.title,
        m.account,
        m.status,
        m.local_user_id,
        m.synced_at,
        u.dept_name,
        u.parent_dept_id::text
      FROM ec_org_members m
      LEFT JOIN ec_org_units u ON u.dept_id = m.dept_id
      ${where}
      ORDER BY m.user_name ASC
    `,
    params,
  );

  const userIds = result.rows.map((row) => row.local_user_id).filter((value): value is string => Boolean(value));
  const users = userIds.length
    ? await query<UserRecord>('SELECT * FROM users WHERE id = ANY($1::uuid[])', [userIds])
    : { rows: [] as UserRecord[] };
  const userMap = new Map(users.rows.map((user) => [user.id, user]));

  return Promise.all(result.rows.map(async (row) => {
    const user = row.local_user_id ? userMap.get(row.local_user_id) ?? null : null;
    return {
      ecUserId: row.ec_user_id,
      deptId: row.dept_id,
      deptName: row.dept_name,
      parentDeptId: row.parent_dept_id,
      userName: row.user_name,
      title: row.title,
      account: row.account,
      status: row.status,
      syncedAt: row.synced_at,
      user: user ? mapOrgSummary(user) : null,
      permissions: user ? await getAccessProfileForUser(user) : null,
    };
  }));
}

export async function grantFeaturesToOrgMembers(params: {
  ecUserIds: string[];
  grants: FeatureGrantInput[];
  actorUserId: string;
}): Promise<{ updatedCount: number }> {
  if (params.ecUserIds.length === 0) {
    throw new ValidationError('ecUserIds must not be empty');
  }

  const result = await query<{ local_user_id: string | null }>(
    `
      SELECT local_user_id
      FROM ec_org_members
      WHERE ec_user_id = ANY($1::text[])
    `,
    [params.ecUserIds],
  );
  const userIds = result.rows.map((row) => row.local_user_id).filter((value): value is string => Boolean(value));
  if (userIds.length === 0) {
    throw new ValidationError('No synchronized users found for the selected EC members');
  }

  const grantResult = await grantFeaturesBatch({ userIds, grants: params.grants, actorUserId: params.actorUserId });
  await recordAuditLog({
    actorUserId: params.actorUserId,
    action: 'org.members.grant',
    targetType: 'org_member',
    targetId: params.ecUserIds.join(','),
    detail: { grants: params.grants, updatedCount: grantResult.updatedCount },
  });
  return grantResult;
}

export async function listEcOrgGrantRules(): Promise<Array<EcOrgGrantRuleRecord & { dept_name: string }>> {
  const result = await query<OrgGrantRuleRow>(
    `
      SELECT
        r.id,
        r.dept_id::text,
        r.project_key,
        r.feature_key,
        r.created_by,
        r.created_at,
        r.updated_at,
        u.dept_name
      FROM ec_org_grant_rules r
      JOIN ec_org_units u ON u.dept_id = r.dept_id
      ORDER BY u.dept_name ASC, r.project_key ASC, r.feature_key ASC
    `,
  );
  return result.rows;
}

export async function upsertEcOrgGrantRules(params: {
  deptId: string;
  grants: FeatureGrantInput[];
  actorUserId: string;
}): Promise<{ deptId: string; createdCount: number }> {
  if (!params.grants.length) {
    throw new ValidationError('grants must not be empty');
  }

  return withTransaction(async (client) => {
    await resolveFeatureRows(client, params.grants);
    let createdCount = 0;
    for (const grant of params.grants) {
      const result = await client.query<{ id: string }>(
        `
          INSERT INTO ec_org_grant_rules (dept_id, project_key, feature_key, created_by)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (dept_id, project_key, feature_key)
          DO UPDATE SET updated_at = NOW()
          RETURNING id
        `,
        [params.deptId, grant.projectKey, grant.featureKey, params.actorUserId],
      );
      if (result.rows[0]) {
        createdCount += 1;
      }
    }

    await applyOrgGrantRulesForDeptIds(client, [params.deptId], params.actorUserId);
    await recordAuditLog({
      client,
      actorUserId: params.actorUserId,
      action: 'org.rule.upsert',
      targetType: 'org_rule',
      targetId: params.deptId,
      detail: { grants: params.grants },
    });

    return { deptId: params.deptId, createdCount };
  });
}

export async function deleteEcOrgGrantRule(params: {
  ruleId: string;
  actorUserId: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<OrgGrantRuleRow>(
      `
        SELECT id, dept_id::text, project_key, feature_key, created_by, created_at, updated_at, '' AS dept_name
        FROM ec_org_grant_rules
        WHERE id = $1
        LIMIT 1
      `,
      [params.ruleId],
    );
    const rule = existing.rows[0];
    if (!rule) {
      throw new ValidationError(`Organization grant rule not found: ${params.ruleId}`);
    }

    const featureRows = await resolveFeatureRows(client, [{ projectKey: rule.project_key, featureKey: rule.feature_key }]);
    await client.query('DELETE FROM ec_org_grant_rules WHERE id = $1', [params.ruleId]);
    await client.query(
      `
        DELETE FROM user_feature_grants
        WHERE grant_source = 'org_rule' AND grant_source_ref = $1 AND feature_id = $2
      `,
      [rule.dept_id, featureRows[0].id],
    );

    await recordAuditLog({
      client,
      actorUserId: params.actorUserId,
      action: 'org.rule.delete',
      targetType: 'org_rule',
      targetId: params.ruleId,
      detail: { deptId: rule.dept_id, projectKey: rule.project_key, featureKey: rule.feature_key },
    });
  });
}