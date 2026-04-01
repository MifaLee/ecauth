import 'dotenv/config';
import express from 'express';

const app = express();

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use('/eclogindemo', express.static(path.join(__dirname, '..', 'public')));

app.get('/eclogindemo/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

app.get('/eclogindemo/auth/login', (_req, res) => {
  const authorizeUrl = process.env.EC_AUTHORIZE_URL!;
  const params = new URLSearchParams({
    client_id: process.env.EC_CLIENT_ID!,
    redirect_uri: process.env.EC_REDIRECT_URI!,
    response_type: 'code',
    scope: 'openid',
  });
  res.redirect(`${authorizeUrl}?${params.toString()}`);
});

app.get('/eclogindemo/auth/callback', async (req, res) => {
  const error = req.query.error as string;
  const errorDescription = req.query.error_description as string;
  if (error) {
    console.error('[OAuth2 Callback Error]', error, errorDescription);
    const encoded = encodeURIComponent(JSON.stringify({ token: { error, error_description: errorDescription }, userinfo: null }));
    res.redirect(`/eclogindemo/?data=${encoded}`);
    return;
  }

  const code = req.query.code as string;
  if (!code) {
    console.error('[OAuth2 Callback] Missing authorization code, query:', req.url);
    res.status(400).send('Missing authorization code');
    return;
  }

  console.log('[OAuth2 Callback] Received code:', code.substring(0, 8) + '...');

  try {
    const credentials = Buffer.from(`${process.env.EC_CLIENT_ID}:${process.env.EC_CLIENT_SECRET}`).toString('base64');
    const tokenResponse = await fetch(process.env.EC_TOKEN_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.EC_REDIRECT_URI!,
      }).toString(),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      res.status(400).json({ error: 'Failed to get access token', details: tokenData });
      return;
    }

    const userinfoResponse = await fetch(process.env.EC_USERINFO_URL!, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const userinfo = await userinfoResponse.json();

    const payload = {
      token: tokenData,
      userinfo,
    };

    const encoded = encodeURIComponent(JSON.stringify(payload));
    res.redirect(`/eclogindemo/?data=${encoded}`);
  } catch (err: any) {
    res.status(500).json({ error: 'OAuth2 callback failed', message: err.message });
  }
});

app.get('/eclogindemo/api/userinfo', async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) {
    res.status(401).json({ error: 'Missing access token' });
    return;
  }

  try {
    const response = await fetch(process.env.EC_USERINFO_URL!, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get user info', message: err.message });
  }
});

app.get('/eclogindemo', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/eclogindemo/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3008;
app.listen(PORT, () => {
  console.log(`EC Login Demo running on port ${PORT}`);
});
