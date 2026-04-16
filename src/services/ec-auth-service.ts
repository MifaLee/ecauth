import { serverConfig } from '../lib/config';
import { ValidationError } from '../lib/errors';
import type { EcIdentityProfile } from '../lib/models';

type EcTokenClientAuthMethod = 'auto' | 'basic' | 'post';

interface EcOAuthErrorPayload {
  error?: string;
  error_description?: string;
  [key: string]: unknown;
}

export class EcOAuthError extends ValidationError {
  constructor(
    public stage: 'callback' | 'token' | 'userinfo',
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function asOAuthErrorPayload(value: unknown): EcOAuthErrorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as EcOAuthErrorPayload;
}

function buildTokenRequestBody(code: string, method: Exclude<EcTokenClientAuthMethod, 'auto'>): string {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: serverConfig.ecRedirectUri,
  });

  if (method === 'post') {
    body.set('client_id', serverConfig.ecClientId);
    body.set('client_secret', serverConfig.ecClientSecret);
  }

  return body.toString();
}

function buildTokenRequestHeaders(method: Exclude<EcTokenClientAuthMethod, 'auto'>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (method === 'basic') {
    const credentials = Buffer.from(`${serverConfig.ecClientId}:${serverConfig.ecClientSecret}`).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
  }

  return headers;
}

function buildEcOAuthMessage(stage: 'callback' | 'token' | 'userinfo', payload: Record<string, unknown>, status?: number): string {
  const oauthPayload = asOAuthErrorPayload(payload);
  const errorCode = typeof oauthPayload.error === 'string' ? oauthPayload.error : '';
  const errorDescription = typeof oauthPayload.error_description === 'string' ? oauthPayload.error_description : '';

  if (stage === 'token') {
    if (errorCode === 'invalid_grant') {
      return 'EC 登录失败：授权码无效、已过期，或 EC 回调地址与当前配置不一致';
    }
    if (errorCode === 'invalid_client') {
      return 'EC 登录失败：应用 client 鉴权未通过，请核对 EC 应用配置与密钥';
    }
  }

  if (stage === 'userinfo') {
    return errorDescription || 'EC 登录失败：无法获取用户信息';
  }

  if (errorDescription) {
    return errorDescription;
  }

  if (errorCode) {
    return `${stage} failed: ${errorCode}`;
  }

  return status ? `${stage} failed with HTTP ${status}` : `${stage} failed`;
}

async function requestEcToken(code: string, method: Exclude<EcTokenClientAuthMethod, 'auto'>): Promise<{
  response: Response;
  tokenData: Record<string, unknown>;
}> {
  const response = await fetch(serverConfig.ecTokenUrl, {
    method: 'POST',
    headers: buildTokenRequestHeaders(method),
    body: buildTokenRequestBody(code, method),
  });

  const tokenData = (await response.json()) as Record<string, unknown>;
  return { response, tokenData };
}

function shouldRetryWithPost(
  method: EcTokenClientAuthMethod,
  attemptedMethod: Exclude<EcTokenClientAuthMethod, 'auto'>,
  response: Response,
  tokenData: Record<string, unknown>,
): boolean {
  if (method !== 'auto' || attemptedMethod !== 'basic' || response.ok) {
    return false;
  }

  const errorCode = typeof tokenData.error === 'string' ? tokenData.error : '';
  return errorCode === 'invalid_client';
}

export function describeEcOAuthError(error: unknown): string {
  if (error instanceof EcOAuthError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'EC 登录失败，请稍后重试';
}

export function getEcOAuthErrorLogDetails(error: unknown): Record<string, unknown> {
  if (error instanceof EcOAuthError) {
    return {
      stage: error.stage,
      ...error.details,
    };
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  return { error };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function profileSources(rawProfile: Record<string, unknown>): Record<string, unknown>[] {
  const nestedData = asObject(rawProfile.data);
  return nestedData ? [nestedData, rawProfile] : [rawProfile];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const source of profileSources(record)) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
      if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
        return String(value);
      }
    }
  }

  return null;
}

function normalizeProfile(rawProfile: Record<string, unknown>): EcIdentityProfile {
  const providerUserId = firstString(rawProfile, [
    'sub',
    'account',
    'open_id',
    'openId',
    'union_id',
    'unionId',
    'uid',
    'user_id',
    'userId',
    'emp_id',
    'employee_id',
    'employeeId',
    'email',
    'mobile',
  ]);
  if (!providerUserId) {
    throw new ValidationError('EC user profile does not contain a stable user identifier');
  }

  const givenName = firstString(rawProfile, ['given_name', 'givenName']);
  const REDACTEDlyName = firstString(rawProfile, ['REDACTEDly_name', 'REDACTEDlyName']);
  const fallbackName = [REDACTEDlyName, givenName].filter(Boolean).join('') || providerUserId;
  const displayName =
    firstString(rawProfile, ['emp_name', 'name', 'nickname', 'display_name', 'displayName'])
    ?? fallbackName;

  return {
    providerUserId,
    employeeId: firstString(rawProfile, ['emp_id', 'employee_id', 'employeeId', 'job_number', 'jobNumber']),
    departmentId: firstString(rawProfile, ['dept_id', 'department_id', 'departmentId']),
    title: firstString(rawProfile, ['title', 'job_title', 'jobTitle']),
    email: firstString(rawProfile, ['email', 'mail']),
    mobile: firstString(rawProfile, ['mobile', 'phone', 'phone_number', 'phoneNumber']),
    displayName,
    rawProfile,
  };
}

export function buildEcAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: serverConfig.ecClientId,
    redirect_uri: serverConfig.ecRedirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
  });

  return `${serverConfig.ecAuthorizeUrl}?${params.toString()}`;
}

export async function exchangeEcCode(code: string): Promise<Record<string, unknown>> {
  const configuredMethod = serverConfig.ecTokenClientAuthMethod;
  const initialMethod = configuredMethod === 'post' ? 'post' : 'basic';
  let { response, tokenData } = await requestEcToken(code, initialMethod);
  let attemptedMethod: Exclude<EcTokenClientAuthMethod, 'auto'> = initialMethod;

  if (shouldRetryWithPost(configuredMethod, attemptedMethod, response, tokenData)) {
    ({ response, tokenData } = await requestEcToken(code, 'post'));
    attemptedMethod = 'post';
  }

  if (!response.ok || typeof tokenData.access_token !== 'string') {
    throw new EcOAuthError('token', buildEcOAuthMessage('token', tokenData, response.status), {
      httpStatus: response.status,
      configuredClientAuthMethod: configuredMethod,
      attemptedClientAuthMethod: attemptedMethod,
      providerError: tokenData.error,
      providerErrorDescription: tokenData.error_description,
    });
  }

  return tokenData;
}

export async function fetchEcUserProfile(accessToken: string): Promise<EcIdentityProfile> {
  const response = await fetch(serverConfig.ecUserinfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const rawProfile = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new EcOAuthError('userinfo', buildEcOAuthMessage('userinfo', rawProfile, response.status), {
      httpStatus: response.status,
      providerError: rawProfile.error,
      providerErrorDescription: rawProfile.error_description,
    });
  }

  return normalizeProfile(rawProfile);
}