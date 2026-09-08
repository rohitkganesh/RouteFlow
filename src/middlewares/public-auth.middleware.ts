import { Request, Response, NextFunction } from 'express';

/**
 * Public Request interface - extends Express Request for public endpoints
 * These endpoints don't require authentication
 */
export interface PublicRequest extends Request {
  // No user property for public endpoints
}

/**
 * Optional authentication middleware for public endpoints
 * If a valid token is provided, it attaches the user to the request
 * If no token or invalid token, it continues without user (public access)
 */
export async function optionalAuth(
  req: PublicRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // This is a placeholder for future enhancement
  // Currently all public endpoints are fully open
  next();
}

/**
 * Rate limiting middleware for public endpoints
 * Prevents abuse of tracking endpoints
 */
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export function publicRateLimit(
  req: PublicRequest,
  res: Response,
  next: NextFunction
): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 30; // 30 requests per minute

  const record = requestCounts.get(ip);

  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + windowMs });
    next();
    return;
  }

  if (record.count >= maxRequests) {
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
        statusCode: 429,
      },
    });
    return;
  }

  record.count++;
  next();
}