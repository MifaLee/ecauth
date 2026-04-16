import type { PoolClient, QueryResultRow } from 'pg';
import { query, withTransaction } from '../lib/db';
import { NotFoundError, ValidationError } from '../lib/errors';
import { readArray, readNonEmptyString, readObject } from '../lib/http';
import type { AccessProfile, ProjectManifestFeatureInput, ProjectManifestInput } from '../lib/models';
import { recordAuditLog } from './audit-service';

interface AccessRow extends QueryResultRow {
  project_key: string;
  project_name: string;
  feature_key: string;
  feature_name: string;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function normalizeFeature(input: unknown): ProjectManifestFeatureInput {
  const feature = readObject(input, 'feature');
  return {
    key: normalizeKey(readNonEmptyString(feature.key, 'feature.key')),
    name: readNonEmptyString(feature.name, 'feature.name'),
    description: typeof feature.description === 'string' ? feature.description.trim() : undefined,
  };
}

function groupAccessRows(rows: AccessRow[]): AccessProfile {
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

export function normalizeProjectManifest(input: unknown): ProjectManifestInput {
  const manifest = readObject(input, 'manifest');
  const features = readArray(manifest.features, 'manifest.features').map((feature) => normalizeFeature(feature));
  if (features.length === 0) {
    throw new ValidationError('manifest.features must contain at least one feature');
  }

  const seen = new Set<string>();
  for (const feature of features) {
    if (seen.has(feature.key)) {
      throw new ValidationError(`Duplicate feature key: ${feature.key}`);
    }
    seen.add(feature.key);
  }

  return {
    projectKey: normalizeKey(readNonEmptyString(manifest.projectKey, 'manifest.projectKey')),
    name: readNonEmptyString(manifest.name, 'manifest.name'),
    description: typeof manifest.description === 'string' ? manifest.description.trim() : undefined,
    features,
  };
}

export async function listProjectCatalog(): Promise<AccessProfile['projects']> {
  const result = await query<AccessRow>(
    `
      SELECT
        p.project_key,
        p.name AS project_name,
        f.feature_key,
        f.name AS feature_name
      FROM projects p
      JOIN features f ON f.project_id = p.id
      WHERE p.status = 'active' AND f.status = 'active'
      ORDER BY p.project_key, f.feature_key
    `,
  );

  return groupAccessRows(result.rows).projects;
}

export async function listProjectFeatureKeys(projectKey: string): Promise<string[]> {
  const result = await query<{ feature_key: string }>(
    `
      SELECT f.feature_key
      FROM projects p
      JOIN features f ON f.project_id = p.id
      WHERE p.project_key = $1 AND p.status = 'active' AND f.status = 'active'
      ORDER BY f.feature_key
    `,
    [projectKey],
  );

  if (result.rowCount === 0) {
    throw new NotFoundError(`Project not found: ${projectKey}`);
  }

  return result.rows.map((row) => row.feature_key);
}

async function upsertProject(client: PoolClient, manifest: ProjectManifestInput): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO projects (project_key, name, description, status)
      VALUES ($1, $2, $3, 'active')
      ON CONFLICT (project_key)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        status = 'active',
        updated_at = NOW()
      RETURNING id
    `,
    [manifest.projectKey, manifest.name, manifest.description ?? null],
  );

  return result.rows[0].id;
}

export async function upsertProjectManifest(manifest: ProjectManifestInput, actorUserId?: string): Promise<AccessProfile['projects'][number]> {
  return withTransaction(async (client) => {
    const projectId = await upsertProject(client, manifest);

    for (const feature of manifest.features) {
      await client.query(
        `
          INSERT INTO features (project_id, feature_key, name, description, status)
          VALUES ($1, $2, $3, $4, 'active')
          ON CONFLICT (project_id, feature_key)
          DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            status = 'active',
            updated_at = NOW()
        `,
        [projectId, feature.key, feature.name, feature.description ?? null],
      );
    }

    await recordAuditLog({
      client,
      actorUserId,
      action: 'project.register',
      targetType: 'project',
      targetId: projectId,
      detail: manifest,
    });

    const result = await client.query<AccessRow>(
      `
        SELECT
          p.project_key,
          p.name AS project_name,
          f.feature_key,
          f.name AS feature_name
        FROM projects p
        JOIN features f ON f.project_id = p.id
        WHERE p.id = $1 AND p.status = 'active' AND f.status = 'active'
        ORDER BY f.feature_key
      `,
      [projectId],
    );

    return groupAccessRows(result.rows).projects[0];
  });
}