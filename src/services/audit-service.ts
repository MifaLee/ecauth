import type { PoolClient } from 'pg';
import { query } from '../lib/db';

export async function recordAuditLog(input: {
  client?: PoolClient;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail?: unknown;
}): Promise<void> {
  const params = [
    input.actorUserId ?? null,
    input.action,
    input.targetType,
    input.targetId,
    JSON.stringify(input.detail ?? {}),
  ];

  if (input.client) {
    await input.client.query(
      `
        INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, detail)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      params,
    );
    return;
  }

  await query(
    `
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, detail)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    params,
  );
}