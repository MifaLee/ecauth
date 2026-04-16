import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { serverConfig, sessionCookieName } from './config';
import type { SessionClaims, UserRecord } from './models';

interface ProjectTokenPayload {
  sub: string;
  projectKey: string;
  features: string[];
  type: 'project';
}

export function signSessionToken(user: UserRecord): string {
  return jwt.sign(
    {
      sub: user.id,
      status: user.status,
      isAdmin: user.is_admin,
      type: 'session',
    },
    serverConfig.sessionSecret,
    {
      expiresIn: `${serverConfig.sessionTtlHours}h`,
    },
  );
}

export function verifySessionToken(token: string): SessionClaims | null {
  try {
    const payload = jwt.verify(token, serverConfig.sessionSecret);
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const decoded = payload as Partial<SessionClaims>;
    if (decoded.type !== 'session' || typeof decoded.sub !== 'string') {
      return null;
    }

    return {
      sub: decoded.sub,
      status: decoded.status ?? 'pending_review',
      isAdmin: Boolean(decoded.isAdmin),
      type: 'session',
    };
  } catch {
    return null;
  }
}

export function signProjectToken(userId: string, projectKey: string, features: string[]): string {
  const payload: ProjectTokenPayload = {
    sub: userId,
    projectKey,
    features,
    type: 'project',
  };

  return jwt.sign(payload, serverConfig.projectTokenSecret, {
    expiresIn: '1h',
    audience: projectKey,
    issuer: 'ecauth',
  });
}

export function extractSessionToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization?.trim();
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  return req.cookies?.[sessionCookieName];
}