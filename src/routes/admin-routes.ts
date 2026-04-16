import { Router } from 'express';
import { ValidationError } from '../lib/errors';
import { asyncHandler, readArray, readBoolean, readNonEmptyString } from '../lib/http';
import type { FeatureGrantInput, UserStatus } from '../lib/models';
import { requireAdmin } from '../middleware/auth';
import { grantFeaturesToOrgMembers, listEcOrgMembers, listEcOrgUnits, syncEcOrganization } from '../services/ec-org-service';
import { listProjectCatalog, normalizeProjectManifest, upsertProjectManifest } from '../services/project-service';
import { grantFeatures, grantFeaturesBatch, listUsersWithPermissions, reviewUser, reviewUsersBatch, revokeFeatures, revokeFeaturesBatch, setUserAdmin } from '../services/user-service';

function readUserIds(value: unknown): string[] {
  return readArray(value, 'userIds').map((item) => readNonEmptyString(item, 'userId'));
}

function readStatus(value: unknown): UserStatus | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const status = readNonEmptyString(value, 'status') as UserStatus;
  if (!['pending_review', 'active', 'rejected', 'disabled'].includes(status)) {
    throw new ValidationError('status is invalid');
  }
  return status;
}

function readGrantInputs(value: unknown): FeatureGrantInput[] {
  return readArray(value, 'grants').map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ValidationError('Each grant must be an object');
    }

    const grant = item as Record<string, unknown>;
    return {
      projectKey: readNonEmptyString(grant.projectKey, 'grant.projectKey'),
      featureKey: readNonEmptyString(grant.featureKey, 'grant.featureKey'),
    };
  });
}

export function createAdminRouter(): Router {
  const router = Router();

  router.get(
    '/api/admin/users',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : undefined;
      const isAdmin = typeof req.query.isAdmin === 'string'
        ? req.query.isAdmin === 'true'
        : undefined;
      const users = await listUsersWithPermissions({
        keyword,
        status: readStatus(req.query.status),
        isAdmin,
      });
      res.json({ users });
    }),
  );

  router.post(
    '/api/admin/users/review-batch',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const action = readNonEmptyString(req.body.action, 'action');
      if (!['approve', 'reject', 'disable'].includes(action)) {
        throw new ValidationError('action must be approve, reject or disable');
      }

      const result = await reviewUsersBatch({
        userIds: readUserIds(req.body.userIds),
        action: action as 'approve' | 'reject' | 'disable',
        note: typeof req.body.note === 'string' ? req.body.note.trim() : undefined,
        reviewerId: req.currentUser!.id,
      });
      res.json(result);
    }),
  );

  router.post(
    '/api/admin/users/:userId/review',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const action = readNonEmptyString(req.body.action, 'action');
      if (!['approve', 'reject', 'disable'].includes(action)) {
        throw new ValidationError('action must be approve, reject or disable');
      }

      const user = await reviewUser({
        userId: req.params.userId,
        action: action as 'approve' | 'reject' | 'disable',
        note: typeof req.body.note === 'string' ? req.body.note.trim() : undefined,
        reviewerId: req.currentUser!.id,
      });
      res.json({ user });
    }),
  );

  router.post(
    '/api/admin/users/:userId/admin',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const user = await setUserAdmin({
        userId: req.params.userId,
        isAdmin: readBoolean(req.body.isAdmin, 'isAdmin'),
        actorUserId: req.currentUser!.id,
      });
      res.json({ user });
    }),
  );

  router.post(
    '/api/admin/users/:userId/grants',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const permissions = await grantFeatures({
        userId: req.params.userId,
        grants: readGrantInputs(req.body.grants),
        actorUserId: req.currentUser!.id,
      });
      res.json({ permissions });
    }),
  );

  router.post(
    '/api/admin/users/grants/batch',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const result = await grantFeaturesBatch({
        userIds: readUserIds(req.body.userIds),
        grants: readGrantInputs(req.body.grants),
        actorUserId: req.currentUser!.id,
      });
      res.json(result);
    }),
  );

  router.delete(
    '/api/admin/users/:userId/grants',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const permissions = await revokeFeatures({
        userId: req.params.userId,
        grants: readGrantInputs(req.body.grants),
        actorUserId: req.currentUser!.id,
      });
      res.json({ permissions });
    }),
  );

  router.delete(
    '/api/admin/users/grants/batch',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const result = await revokeFeaturesBatch({
        userIds: readUserIds(req.body.userIds),
        grants: readGrantInputs(req.body.grants),
        actorUserId: req.currentUser!.id,
      });
      res.json(result);
    }),
  );

  router.get(
    '/api/admin/projects',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const projects = await listProjectCatalog();
      res.json({ projects });
    }),
  );

  router.post(
    '/api/admin/projects/register',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const manifest = normalizeProjectManifest(req.body);
      const project = await upsertProjectManifest(manifest, req.currentUser!.id);
      res.json({ project });
    }),
  );

  router.post(
    '/api/admin/org/sync',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const summary = await syncEcOrganization(req.currentUser!.id);
      res.json({ summary });
    }),
  );

  router.get(
    '/api/admin/org/units',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const units = await listEcOrgUnits();
      res.json({ units });
    }),
  );

  router.get(
    '/api/admin/org/members',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const members = await listEcOrgMembers({
        keyword: typeof req.query.keyword === 'string' ? req.query.keyword.trim() : undefined,
        deptId: typeof req.query.deptId === 'string' ? req.query.deptId.trim() : undefined,
        status: typeof req.query.status === 'string' && req.query.status !== '' ? Number(req.query.status) : undefined,
      });
      res.json({ members });
    }),
  );

  router.post(
    '/api/admin/org/members/grants',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const result = await grantFeaturesToOrgMembers({
        ecUserIds: readArray(req.body.ecUserIds, 'ecUserIds').map((item) => readNonEmptyString(item, 'ecUserId')),
        grants: readGrantInputs(req.body.grants),
        actorUserId: req.currentUser!.id,
      });
      res.json(result);
    }),
  );

  return router;
}