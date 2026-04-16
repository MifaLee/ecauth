import type { SessionClaims, UserRecord } from './lib/models';

declare global {
  namespace Express {
    interface Request {
      auth?: SessionClaims;
      currentUser?: UserRecord;
    }
  }
}

export {};