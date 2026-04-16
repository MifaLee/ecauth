import { parseBoolean, parseCsv, parseNumber, requiredEnv } from './env';

function parseEcTokenClientAuthMethod(value: string | undefined): 'auto' | 'basic' | 'post' {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'basic' || normalized === 'post' || normalized === 'auto') {
    return normalized;
  }

  return 'auto';
}

function normalizeBasePath(value: string | undefined): string {
  const raw = (value?.trim() || '/ecauth').replace(/\/+$/, '');
  if (!raw) {
    return '/ecauth';
  }

  return raw.startsWith('/') ? raw : `/${raw}`;
}

export const sessionCookieName = 'platform_session';
export const oauthStateCookieName = 'platform_oauth_state';
export const oauthContextCookieName = 'platform_oauth_context';

export const serverConfig = {
  port: parseNumber(process.env.PORT, 3008),
  basePath: normalizeBasePath(process.env.APP_BASE_PATH),
  ecClientId: requiredEnv('EC_CLIENT_ID'),
  ecClientSecret: requiredEnv('EC_CLIENT_SECRET'),
  ecAuthorizeUrl: requiredEnv('EC_AUTHORIZE_URL'),
  ecTokenUrl: requiredEnv('EC_TOKEN_URL'),
  ecTokenClientAuthMethod: parseEcTokenClientAuthMethod(process.env.EC_TOKEN_CLIENT_AUTH_METHOD),
  ecUserinfoUrl: requiredEnv('EC_USERINFO_URL'),
  ecRedirectUri: requiredEnv('EC_REDIRECT_URI'),
  ecOpenApiBaseUrl: (process.env.EC_OPEN_API_BASE_URL?.trim() || 'https://open.workec.com').replace(/\/+$/, ''),
  ecOpenCorpId: process.env.EC_OPEN_CORP_ID?.trim() || '',
  ecOpenAppId: process.env.EC_OPEN_APP_ID?.trim() || '',
  ecOpenAppSecret: process.env.EC_OPEN_APP_SECRET?.trim() || '',
  sessionSecret: requiredEnv('SESSION_SECRET'),
  projectTokenSecret: process.env.PROJECT_TOKEN_SECRET?.trim() || requiredEnv('SESSION_SECRET'),
  cookieSecure: parseBoolean(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  sessionTtlHours: parseNumber(process.env.SESSION_TTL_HOURS, 12),
  platformAdminIdentifiers: parseCsv(process.env.PLATFORM_ADMIN_IDENTIFIERS).map((item) => item.toLowerCase()),
  allowedReturnToOrigins: parseCsv(process.env.ALLOWED_RETURN_TO_ORIGINS).map((item) => item.toLowerCase()),
};

export function buildCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: serverConfig.cookieSecure,
    path: serverConfig.basePath,
    maxAge: maxAgeMs,
  };
}

export function buildClearCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: serverConfig.cookieSecure,
    path: serverConfig.basePath,
  };
}