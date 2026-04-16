import 'dotenv/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAdminRouter } from './routes/admin-routes';
import { createAuthRouter } from './routes/auth-routes';
import { serverConfig } from './lib/config';
import { AppError } from './lib/errors';
import { loadAuthContext } from './middleware/auth';

const app = express();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json());
app.use(cookieParser());
app.use(serverConfig.basePath, loadAuthContext);

app.get(`${serverConfig.basePath}/health`, (_req, res) => {
  res.json({ status: 'ok', service: 'ecauth', version: '2.0.0' });
});

app.use(serverConfig.basePath, createAuthRouter());
app.use(serverConfig.basePath, createAdminRouter());
app.use(serverConfig.basePath, express.static(publicDir));

app.get(serverConfig.basePath, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get(`${serverConfig.basePath}/`, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get(`${serverConfig.basePath}/admin`, (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get(`${serverConfig.basePath}/admin/`, (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(serverConfig.port, () => {
  console.log(`ecauth listening on port ${serverConfig.port}`);
});
