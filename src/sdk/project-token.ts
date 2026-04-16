import jwt from 'jsonwebtoken';

export interface ProjectAccessTokenClaims {
  sub: string;
  projectKey: string;
  features: string[];
  type: 'project';
  aud?: string;
  iss?: string;
}

export function verifyProjectAccessToken(params: {
  token: string;
  projectKey: string;
  secret: string;
}): ProjectAccessTokenClaims {
  const payload = jwt.verify(params.token, params.secret, {
    audience: params.projectKey,
    issuer: 'ecauth',
  });

  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid project token payload');
  }

  const claims = payload as Partial<ProjectAccessTokenClaims>;
  if (claims.type !== 'project' || claims.projectKey !== params.projectKey || !Array.isArray(claims.features)) {
    throw new Error('Project token claims mismatch');
  }

  return {
    sub: String(claims.sub),
    projectKey: String(claims.projectKey),
    features: claims.features.map((item) => String(item)),
    type: 'project',
    aud: claims.aud,
    iss: claims.iss,
  };
}

export function hasProjectFeature(claims: ProjectAccessTokenClaims, featureKey: string): boolean {
  return claims.features.includes(featureKey);
}