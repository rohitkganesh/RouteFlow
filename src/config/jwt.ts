import { config } from './env';
import { verify, VerifyErrors } from 'jsonwebtoken';

export const jwtConfig = {
  secret: config.JWT_SECRET,
  expiresIn: config.JWT_EXPIRES_IN,
  refreshSecret: config.JWT_REFRESH_SECRET,
  refreshExpiresIn: config.JWT_REFRESH_EXPIRES_IN,
} as const;

// Issuer / audience claims used both when signing and when verifying tokens.
// Exposed as public constants so this module can verify tokens on its own
// (used by the socket.io handshake middleware) without depending on the
// AuthService class — which keeps imports one-way and avoids a cycle.
export const TOKEN_ISSUER = 'routeflow';
export const TOKEN_AUDIENCE = 'routeflow-api';

export type JwtPayload = {
  sub: string; // user id
  email: string;
  role: 'admin' | 'seller' | 'driver';
  iat?: number;
  exp?: number;
};

export type JWTPayload = JwtPayload;

export type RefreshTokenPayload = {
  sub: string;
  type: 'refresh';
  iat?: number;
  exp?: number;
};

/**
 * Verify an access token and return its payload.
 *
 * Throws a plain `Error` whose message is the JWT error name so the
 * socket.io middleware can decide between 'expired' and 'invalid'
 * (the message is forwarded to the client and used to trigger a
 * silent refresh on the frontend).
 *
 * NOTE: This is the canonical verifier. `AuthService.verifyAccessToken`
 * wraps this and adds `AuthError` semantics for HTTP routes; both must
 * stay in sync (same secret, same issuer, same audience).
 */
export function verifyAccessToken(token: string): JWTPayload {
  try {
    const decoded = verify(token, jwtConfig.secret, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });
    return decoded as JWTPayload;
  } catch (err) {
    const e = err as VerifyErrors;
    // Re-throw with a message that the socket.io client can recognise.
    // The existing client matches on "Invalid token", "Token expired",
    // and a few other strings — keep that contract intact.
    if (e?.name === 'TokenExpiredError') {
      throw new Error('Token expired');
    }
    throw new Error('Invalid token');
  }
}
