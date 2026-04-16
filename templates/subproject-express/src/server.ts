import 'dotenv/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';

const app = express();
app.use(cookieParser());

const port = Number(process.env.PORT || '__SUBPROJECT_PORT__');
const authPlatformBaseUrl = (process.env.AUTH_PLATFORM_BASE_URL || '__AUTH_PLATFORM_BASE_URL__').replace(/\/+$/, '');
const projectKey = process.env.PROJECT_KEY || '__PROJECT_KEY__';
const callbackUrl = process.env.SUBPROJECT_CALLBACK_URL || '__SUBPROJECT_CALLBACK_URL__';
const projectTokenSecret = process.env.PROJECT_TOKEN_SECRET || 'change_me_to_a_long_random_secret';
const tokenCookieName = 'project_access_token';

function buildLoginUrl(): string {
  const url = new URL(`${authPlatformBaseUrl}/auth/login`);
  url.searchParams.set('projectKey', projectKey);
  url.searchParams.set('returnTo', callbackUrl);
  return url.toString();
}

function readTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map((item) => item.trim());
  for (const part of parts) {
    const [name, ...rest] = part.split('=');
    if (name === tokenCookieName) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

function verifyProjectToken(token: string): { sub: string; features: string[] } {
  const payload = jwt.verify(token, projectTokenSecret, {
    audience: projectKey,
    issuer: 'ecauth',
  });
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.features)) {
    throw new Error('Invalid token payload');
  }
  return {
    sub: String(payload.sub),
    features: payload.features.map((item) => String(item)),
  };
}

function requireLogin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = readTokenFromCookie(req.headers.cookie);
  if (!token) {
    res.redirect(buildLoginUrl());
    return;
  }

  try {
    const claims = verifyProjectToken(token);
    res.locals.projectAccess = claims;
    next();
  } catch {
    res.redirect(buildLoginUrl());
  }
}

function requireFeature(featureKey: string): express.RequestHandler {
  return (req, res, next) => {
    const token = readTokenFromCookie(req.headers.cookie);
    if (!token) {
      res.redirect(buildLoginUrl());
      return;
    }

    try {
      const claims = verifyProjectToken(token);
      if (!claims.features.includes(featureKey)) {
        res.status(403).send(`Feature access denied: ${featureKey}`);
        return;
      }
      res.locals.projectAccess = claims;
      next();
    } catch {
      res.redirect(buildLoginUrl());
    }
  };
}

app.get('/', (_req, res) => {
  res.redirect('/dashboard');
});

app.get('/login', (_req, res) => {
  res.redirect(buildLoginUrl());
});

app.get('/auth/callback', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';
  const message = typeof req.query.message === 'string' ? req.query.message : '';

  if (error) {
    res.status(403).send(`Login failed: ${message || error}`);
    return;
  }

  if (!token) {
    res.status(400).send('Missing project token');
    return;
  }

  res.cookie(tokenCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 60 * 60 * 1000,
  });
  res.redirect('/dashboard');
});

app.get('/dashboard', requireLogin, (_req, res) => {
  res.send('Dashboard access granted for __PROJECT_NAME__');
});

app.get('/reports', requireFeature('report:export'), (_req, res) => {
  res.send('Report export access granted');
});

app.listen(port, () => {
  console.log(`__PROJECT_NAME__ listening on http://localhost:${port}`);
});