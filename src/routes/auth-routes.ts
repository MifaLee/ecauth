import { randomUUID } from 'crypto';
import { Router } from 'express';
import { buildClearCookieOptions, buildCookieOptions, oauthContextCookieName, oauthStateCookieName, serverConfig, sessionCookieName } from '../lib/config';
import { ValidationError } from '../lib/errors';
import { asyncHandler, readNonEmptyString } from '../lib/http';
import { signProjectToken, signSessionToken } from '../lib/session';
import { requireAuthenticated } from '../middleware/auth';
import { buildEcAuthorizeUrl, describeEcOAuthError, exchangeEcCode, fetchEcUserProfile, getEcOAuthErrorLogDetails } from '../services/ec-auth-service';
import { getAccessProfileForUser, getProjectFeaturesForUser, hasFeatureAccess, syncUserFromEcLogin, toPublicUser } from '../services/user-service';

interface OAuthContextPayload {
  state: string;
  returnTo?: string;
  projectKey?: string;
}

function encodeContext(context: OAuthContextPayload): string {
  return Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');
}

function decodeContext(rawValue: string | undefined): OAuthContextPayload | null {
  if (!rawValue) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(rawValue, 'base64url').toString('utf8')) as Partial<OAuthContextPayload>;
    if (!decoded || typeof decoded.state !== 'string') {
      return null;
    }

    return {
      state: decoded.state,
      returnTo: typeof decoded.returnTo === 'string' ? decoded.returnTo : undefined,
      projectKey: typeof decoded.projectKey === 'string' ? decoded.projectKey : undefined,
    };
  } catch {
    return null;
  }
}

function validateReturnTo(returnTo: string | undefined): string | undefined {
  if (!returnTo) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    throw new ValidationError('returnTo must be an absolute URL');
  }

  if (!serverConfig.allowedReturnToOrigins.includes(url.origin.toLowerCase())) {
    throw new ValidationError(`returnTo origin is not allowed: ${url.origin}`);
  }

  return url.toString();
}

function appendQuery(urlString: string, values: Record<string, string>): string {
  const url = new URL(urlString);
  Object.entries(values).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

function redirectToHomeWithError(error: string): string {
  return `${serverConfig.basePath}/?${new URLSearchParams({ error }).toString()}`;
}

function redirectToHomeWithMessage(message: string): string {
  return `${serverConfig.basePath}/?${new URLSearchParams({ message }).toString()}`;
}

export function createAuthRouter(): Router {
  const router = Router();

  router.get('/auth/login', (req, res) => {
    const state = randomUUID();
    res.cookie(oauthStateCookieName, state, buildCookieOptions(10 * 60 * 1000));
    const projectKey = typeof req.query.projectKey === 'string' ? req.query.projectKey.trim() : '';
    const returnTo = validateReturnTo(typeof req.query.returnTo === 'string' ? req.query.returnTo.trim() : undefined);
    const context: OAuthContextPayload = {
      state,
      returnTo,
      projectKey: projectKey || undefined,
    };
    res.cookie(oauthContextCookieName, encodeContext(context), buildCookieOptions(10 * 60 * 1000));
    console.info('[EC OAuth Login Start]', {
      state,
      hasProjectKey: Boolean(context.projectKey),
      hasReturnTo: Boolean(context.returnTo),
    });
    res.redirect(buildEcAuthorizeUrl(state));
  });

  router.get(
    '/auth/callback',
    asyncHandler(async (req, res) => {
      const error = typeof req.query.error === 'string' ? req.query.error : '';
      const errorDescription = typeof req.query.error_description === 'string' ? req.query.error_description : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      if (error) {
        res.clearCookie(oauthStateCookieName, buildClearCookieOptions());
        res.clearCookie(oauthContextCookieName, buildClearCookieOptions());
        console.warn('[EC OAuth Callback Error]', {
          error,
          errorDescription,
          state,
        });
        res.redirect(redirectToHomeWithError(errorDescription || error));
        return;
      }

      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const oauthContext = decodeContext(req.cookies?.[oauthContextCookieName]);
      if (!code) {
        throw new ValidationError('Missing authorization code');
      }
      if (!state || state !== req.cookies?.[oauthStateCookieName] || !oauthContext || oauthContext.state !== state) {
        res.clearCookie(oauthStateCookieName, buildClearCookieOptions());
        res.clearCookie(oauthContextCookieName, buildClearCookieOptions());
        res.redirect(redirectToHomeWithError('Invalid OAuth state'));
        return;
      }

      let user;
      try {
        const tokenData = await exchangeEcCode(code);
        const accessToken = String(tokenData.access_token);
        const ecProfile = await fetchEcUserProfile(accessToken);
        user = await syncUserFromEcLogin(ecProfile);
      } catch (error) {
        res.clearCookie(oauthStateCookieName, buildClearCookieOptions());
        res.clearCookie(oauthContextCookieName, buildClearCookieOptions());
        console.error('[EC OAuth Login Failure]', {
          state,
          ...getEcOAuthErrorLogDetails(error),
        });
        res.redirect(redirectToHomeWithError(describeEcOAuthError(error)));
        return;
      }

      const sessionToken = signSessionToken(user);

      res.clearCookie(oauthStateCookieName, buildClearCookieOptions());
      res.clearCookie(oauthContextCookieName, buildClearCookieOptions());
      res.cookie(
        sessionCookieName,
        sessionToken,
        buildCookieOptions(serverConfig.sessionTtlHours * 60 * 60 * 1000),
      );

      if (oauthContext.returnTo) {
        if (user.status !== 'active') {
          res.redirect(appendQuery(oauthContext.returnTo, {
            error: 'user_not_approved',
            message: '账号已创建但仍待审核，当前无法进入子项目。',
          }));
          return;
        }

        if (!oauthContext.projectKey) {
          res.redirect(appendQuery(oauthContext.returnTo, {
            error: 'missing_project_key',
            message: '未提供 projectKey，无法签发项目令牌。',
          }));
          return;
        }

        try {
          const features = await getProjectFeaturesForUser(user, oauthContext.projectKey);
          const token = signProjectToken(user.id, oauthContext.projectKey, features);
          res.redirect(appendQuery(oauthContext.returnTo, {
            token,
            projectKey: oauthContext.projectKey,
            status: 'success',
          }));
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : '无法为子项目签发访问令牌';
          res.redirect(appendQuery(oauthContext.returnTo, {
            error: 'project_access_denied',
            message,
          }));
          return;
        }
      }

      const message =
        user.status === 'pending_review'
          ? 'EC 登录成功，账号已创建，等待管理员审核后可使用系统功能。'
          : 'EC 登录成功';
      res.redirect(redirectToHomeWithMessage(message));
    }),
  );

  router.post('/auth/logout', (_req, res) => {
    res.clearCookie(sessionCookieName, buildClearCookieOptions());
    res.json({ ok: true });
  });

  router.get(
    '/api/auth/status',
    asyncHandler(async (req, res) => {
      if (!req.currentUser) {
        res.json({ authenticated: false, basePath: serverConfig.basePath });
        return;
      }

      const permissions = await getAccessProfileForUser(req.currentUser);
      res.json({
        authenticated: true,
        user: toPublicUser(req.currentUser),
        permissions,
        basePath: serverConfig.basePath,
      });
    }),
  );

  router.get(
    '/api/auth/me',
    requireAuthenticated,
    asyncHandler(async (req, res) => {
      const permissions = await getAccessProfileForUser(req.currentUser!);
      res.json({ user: toPublicUser(req.currentUser!), permissions });
    }),
  );

  router.get(
    '/api/access/check',
    requireAuthenticated,
    asyncHandler(async (req, res) => {
      const projectKey = readNonEmptyString(req.query.projectKey, 'projectKey');
      const featureKey = readNonEmptyString(req.query.featureKey, 'featureKey');
      const allowed = await hasFeatureAccess(req.currentUser!, projectKey, featureKey);
      res.json({ allowed, projectKey, featureKey, userStatus: req.currentUser!.status });
    }),
  );

  router.post(
    '/api/auth/project-token',
    requireAuthenticated,
    asyncHandler(async (req, res) => {
      const projectKey = readNonEmptyString(req.body.projectKey, 'projectKey');
      const features = await getProjectFeaturesForUser(req.currentUser!, projectKey);
      const token = signProjectToken(req.currentUser!.id, projectKey, features);
      res.json({ projectKey, features, token });
    }),
  );

  return router;
}