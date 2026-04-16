import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { buildSubprojectLoginUrl } from './auth-platform-client';
import { hasProjectFeature, verifyProjectAccessToken, type ProjectAccessTokenClaims } from './project-token';

export interface SubprojectMiddlewareOptions {
  authPlatformBaseUrl: string;
  projectKey: string;
  projectTokenSecret: string;
  callbackUrl: string;
  tokenCookieName?: string;
}

declare global {
  namespace Express {
    interface Request {
      projectAccess?: ProjectAccessTokenClaims;
    }
  }
}

function readCookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  const parts = cookieHeader.split(';').map((item) => item.trim());
  for (const part of parts) {
    const [name, ...rest] = part.split('=');
    if (name === cookieName) {
      return decodeURIComponent(rest.join('='));
    }
  }

  return null;
}

export function createSubprojectMiddleware(options: SubprojectMiddlewareOptions): {
  requireLogin: RequestHandler;
  requireFeature: (featureKey: string) => RequestHandler;
  loginUrl: string;
  tokenCookieName: string;
} {
  const tokenCookieName = options.tokenCookieName ?? 'project_access_token';
  const loginUrl = buildSubprojectLoginUrl({
    authPlatformBaseUrl: options.authPlatformBaseUrl,
    projectKey: options.projectKey,
    returnTo: options.callbackUrl,
  });

  function decodeToken(req: Request): ProjectAccessTokenClaims | null {
    const token = readCookieValue(req.headers.cookie, tokenCookieName);
    if (!token) {
      return null;
    }

    try {
      return verifyProjectAccessToken({
        token,
        projectKey: options.projectKey,
        secret: options.projectTokenSecret,
      });
    } catch {
      return null;
    }
  }

  const requireLogin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const claims = decodeToken(req);
    if (!claims) {
      res.redirect(loginUrl);
      return;
    }

    req.projectAccess = claims;
    next();
  };

  const requireFeature = (featureKey: string): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction) => {
      const claims = decodeToken(req);
      if (!claims) {
        res.redirect(loginUrl);
        return;
      }
      if (!hasProjectFeature(claims, featureKey)) {
        res.status(403).send(`Feature access denied: ${featureKey}`);
        return;
      }

      req.projectAccess = claims;
      next();
    };
  };

  return {
    requireLogin,
    requireFeature,
    loginUrl,
    tokenCookieName,
  };
}