import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { AuthService, AuthError } from '../services/auth.service';
import { registerSchema, loginSchema, refreshTokenSchema } from '../models/validation';
import { UnauthorizedError, ValidationError, ConflictError } from '../utils/errors';
import { Response, NextFunction } from 'express';
import { AuthTokens } from '../models';

export class AuthController {
  static async register(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const input = registerSchema.parse(req.body);
      const { user, tokens } = await AuthService.register({
        email: input.email,
        password: input.password,
        role: input.role,
        profileDetails: input.profileDetails,
      });

      res.cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.status(201).json({
        success: true,
        data: { user, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: 15 * 60 },
        message: 'Registration successful',
      });
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.code === 'EMAIL_EXISTS') {
          return next(new ConflictError(error.message));
        }
      }
      next(error);
    }
  }

  static async login(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const input = loginSchema.parse(req.body);
      const { user, tokens } = await AuthService.login(input);

      res.cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.json({
        success: true,
        data: { user, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: 15 * 60 }, // 15 minutes in seconds
        message: 'Login successful',
      });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
        return next(new UnauthorizedError('Invalid email or password'));
      }
      next(error);
    }
  }

  static async refresh(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const refreshToken = req.body.refreshToken || req.cookies?.refreshToken;

      if (!refreshToken) {
        throw new UnauthorizedError('Refresh token required');
      }

      const tokens = await AuthService.refresh(refreshToken);

      res.cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.json({
        success: true,
        data: { accessToken: tokens.accessToken },
        message: 'Token refreshed',
      });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'INVALID_REFRESH_TOKEN') {
        return next(new UnauthorizedError('Invalid or expired refresh token'));
      }
      next(error);
    }
  }

  static async logout(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const refreshToken = req.body.refreshToken || req.cookies?.refreshToken;

      if (refreshToken) {
        await AuthService.revokeRefreshToken(refreshToken);
      }

      res.clearCookie('refreshToken', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
      });

      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async me(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required');
      }

      const user = await AuthService.getUserById(req.user.sub);

      if (!user) {
        throw new UnauthorizedError('User not found');
      }

      res.json({
        success: true,
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }
}