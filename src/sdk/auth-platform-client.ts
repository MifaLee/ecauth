export interface AuthPlatformClientOptions {
  authPlatformBaseUrl: string;
  projectKey: string;
  returnTo: string;
}

export interface AuthPlatformStatusUser {
  id: string;
  employeeId: string | null;
  email: string | null;
  mobile: string | null;
  displayName: string;
  status: string;
  isAdmin: boolean;
}

export interface AuthPlatformStatusResponse {
  authenticated: boolean;
  user?: AuthPlatformStatusUser;
  permissions?: {
    isAdmin: boolean;
    projects: Array<{
      projectKey: string;
      projectName: string;
      features: Array<{
        featureKey: string;
        featureName: string;
      }>;
    }>;
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function buildSubprojectLoginUrl(options: AuthPlatformClientOptions): string {
  const url = new URL(`${normalizeBaseUrl(options.authPlatformBaseUrl)}/auth/login`);
  url.searchParams.set('projectKey', options.projectKey);
  url.searchParams.set('returnTo', options.returnTo);
  return url.toString();
}

export async function fetchAuthPlatformSession(authPlatformBaseUrl: string, cookieHeader?: string): Promise<AuthPlatformStatusResponse> {
  const response = await fetch(`${normalizeBaseUrl(authPlatformBaseUrl)}/api/auth/status`, {
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch auth status: ${response.status}`);
  }

  return response.json() as Promise<AuthPlatformStatusResponse>;
}

export async function checkFeatureAccess(params: {
  authPlatformBaseUrl: string;
  projectKey: string;
  featureKey: string;
  cookieHeader?: string;
}): Promise<boolean> {
  const url = new URL(`${normalizeBaseUrl(params.authPlatformBaseUrl)}/api/access/check`);
  url.searchParams.set('projectKey', params.projectKey);
  url.searchParams.set('featureKey', params.featureKey);

  const response = await fetch(url, {
    headers: params.cookieHeader ? { Cookie: params.cookieHeader } : undefined,
  });

  if (!response.ok) {
    return false;
  }

  const payload = await response.json() as { allowed?: boolean };
  return Boolean(payload.allowed);
}