import type { NextFunction, Request, Response } from 'express';
import { buildClearCookieOptions, sessionCookieName } from '../lib/config';
import { ForbiddenError, UnauthorizedError } from '../lib/errors';
import { extractSessionToken, verifySessionToken } from '../lib/session';
import { getUserById } from '../services/user-service';

export async function loadAuthContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractSessionToken(req);
  if (!token) {
    next();
    return;
  }

  const claims = verifySessionToken(token);
  if (!claims) {
    if (req.cookies?.[sessionCookieName]) {
      res.clearCookie(sessionCookieName, buildClearCookieOptions());
    }
    next();
    return;
  }

  const user = await getUserById(claims.sub);
  if (!user) {
    if (req.cookies?.[sessionCookieName]) {
      res.clearCookie(sessionCookieName, buildClearCookieOptions());
    }
    next();
    return;
  }

  req.auth = claims;
  req.currentUser = user;
  next();
}

export function requireAuthenticated(req: Request, _res: Response, next: NextFunction): void {
  if (!req.currentUser) {
    next(new UnauthorizedError('Login required'));
    return;
  }

  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.currentUser) {
    next(new UnauthorizedError('Login required'));
    return;
  }
  if (req.currentUser.status !== 'active') {
    next(new ForbiddenError('User is not approved yet'));
    return;
  }
  if (!req.currentUser.is_admin) {
    next(new ForbiddenError('Admin permission required'));
    return;
  }

  next();
}