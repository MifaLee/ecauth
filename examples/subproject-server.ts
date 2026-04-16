import express from 'express';
import { createSubprojectMiddleware } from '../src/sdk/express-integration';

const app = express();
const port = Number(process.env.PORT || 3010);

const auth = createSubprojectMiddleware({
  authPlatformBaseUrl: process.env.AUTH_PLATFORM_BASE_URL || 'http://localhost:3008/ecauth',
  projectKey: 'sales-crm',
  projectTokenSecret: process.env.PROJECT_TOKEN_SECRET || 'change_me_to_a_long_random_secret',
  callbackUrl: process.env.SUBPROJECT_CALLBACK_URL || 'http://localhost:3010/auth/callback',
});

app.get('/login', (_req, res) => {
  res.redirect(auth.loginUrl);
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
    res.status(400).send('Missing project access token');
    return;
  }

  res.cookie(auth.tokenCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 60 * 60 * 1000,
  });
  res.redirect('/dashboard');
});

app.get('/dashboard', auth.requireLogin, (_req, res) => {
  res.send('Dashboard access granted');
});

app.get('/reports', auth.requireFeature('report:export'), (_req, res) => {
  res.send('Report export access granted');
});

app.listen(port, () => {
  console.log(`Subproject example listening on http://localhost:${port}`);
});