import { knex } from '../config/database';
import { config } from '../config/env';
import { encryptObject, decryptObject } from '../config/encryption';
import { jwtConfig, JWTPayload, RefreshTokenPayload } from '../config/jwt';
import { compare, hash } from 'bcrypt';
import { sign, verify, SignOptions, JwtPayload } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { User, CreateUserInput, UserRole, UserProfileDetails, AuthTokens, LoginInput } from '../models';
import { DriverService } from './driver.service';

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'AUTH_ERROR',
    public readonly statusCode: number = 401
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthService {
  private static readonly TOKEN_ISSUER = 'routeflow';
  private static readonly TOKEN_AUDIENCE = 'routeflow-api';

  static async register(input: CreateUserInput): Promise<{ user: Omit<User, 'password_hash'>; tokens: AuthTokens }> {
    const existingUser = await knex('users').where({ email: input.email.toLowerCase() }).first();
    if (existingUser) {
      throw new AuthError('Email already registered', 'EMAIL_EXISTS', 409);
    }

    const passwordHash = await hash(input.password, config.BCRYPT_ROUNDS);
    const now = new Date();

    const profileDetails: UserProfileDetails = {
      firstName: input.profileDetails?.firstName,
      lastName: input.profileDetails?.lastName,
      phone: input.profileDetails?.phone,
      address: input.profileDetails?.address,
      avatarUrl: input.profileDetails?.avatarUrl,
      preferences: input.profileDetails?.preferences ?? {},
    };

    const encryptedProfile = encryptObject(profileDetails);

    const [user] = await knex('users')
      .insert({
        id: randomUUID(),
        email: input.email.toLowerCase(),
        password_hash: passwordHash,
        role: input.role,
        profile_details: encryptedProfile,
        created_at: now,
      })
      .returning(['id', 'email', 'role', 'profile_details', 'created_at']);

    // Auto-create driver profile if role is 'driver'
    if (input.role === 'driver') {
      await DriverService.createDriverProfile(user.id);
    }

    const decryptedProfile = decryptObject(user.profile_details);

    const tokens = this.generateTokens({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    await this.storeRefreshToken(user.id, tokens.refreshToken);

    return {
      user: { ...user, profile_details: decryptedProfile },
      tokens,
    };
  }

  static async login(input: LoginInput): Promise<{ user: Omit<User, 'password_hash'>; tokens: AuthTokens }> {
    const user = await knex('users').where({ email: input.email.toLowerCase() }).first();
    if (!user) {
      throw new AuthError('Invalid credentials', 'INVALID_CREDENTIALS', 401);
    }

    const isValid = await compare(input.password, user.password_hash);
    if (!isValid) {
      throw new AuthError('Invalid credentials', 'INVALID_CREDENTIALS', 401);
    }

    const decryptedProfile = decryptObject(user.profile_details);

    const tokens = this.generateTokens({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    await this.storeRefreshToken(user.id, tokens.refreshToken);

    const { password_hash, ...userWithoutPassword } = user;
    return {
      user: { ...userWithoutPassword, profile_details: decryptedProfile },
      tokens,
    };
  }

  static async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: RefreshTokenPayload;
    try {
      payload = verify(refreshToken, jwtConfig.refreshSecret, {
        issuer: this.TOKEN_ISSUER,
        audience: this.TOKEN_AUDIENCE,
      }) as RefreshTokenPayload;
    } catch {
      throw new AuthError('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN', 401);
    }

    const stored = await knex('refresh_tokens')
      .where({ user_id: payload.sub, token: refreshToken, revoked: false })
      .where('expires_at', '>', new Date())
      .first();

    if (!stored) {
      throw new AuthError('Refresh token revoked or expired', 'TOKEN_REVOKED', 401);
    }

    const user = await knex('users').where({ id: payload.sub }).first();
    if (!user) {
      throw new AuthError('User not found', 'USER_NOT_FOUND', 404);
    }

    await knex('refresh_tokens').where({ id: stored.id }).update({ revoked: true });

    const tokens = this.generateTokens({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    await this.storeRefreshToken(user.id, tokens.refreshToken);

    return tokens;
  }

  static async logout(userId: string, refreshToken: string): Promise<void> {
    await knex('refresh_tokens').where({ user_id: userId, token: refreshToken }).update({ revoked: true });
  }

  static async revokeRefreshToken(refreshToken: string): Promise<void> {
    await knex('refresh_tokens').where({ token: refreshToken }).update({ revoked: true });
  }

  static async logoutAll(userId: string): Promise<void> {
    await knex('refresh_tokens').where({ user_id: userId, revoked: false }).update({ revoked: true });
  }

  static verifyAccessToken(token: string): JWTPayload {
    try {
      return verify(token, jwtConfig.secret, {
        issuer: this.TOKEN_ISSUER,
        audience: this.TOKEN_AUDIENCE,
      }) as JWTPayload;
    } catch (error) {
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        throw new AuthError('Access token expired', 'TOKEN_EXPIRED', 401);
      }
      throw new AuthError('Invalid access token', 'INVALID_TOKEN', 401);
    }
  }

  static async getUserById(userId: string): Promise<Omit<User, 'password_hash'> | null> {
    const user = await knex('users').where({ id: userId }).first();
    if (!user) return null;
    return { ...user, profile_details: decryptObject(user.profile_details) };
  }

  private static generateTokens(payload: Omit<JWTPayload, 'iat' | 'exp'>): AuthTokens {
    const signOptions: SignOptions = {
      issuer: this.TOKEN_ISSUER,
      audience: this.TOKEN_AUDIENCE,
      expiresIn: jwtConfig.expiresIn as SignOptions['expiresIn'],
    };

    const refreshOptions: SignOptions = {
      issuer: this.TOKEN_ISSUER,
      audience: this.TOKEN_AUDIENCE,
      expiresIn: jwtConfig.refreshExpiresIn as SignOptions['expiresIn'],
    };

    const accessToken = sign(payload, jwtConfig.secret, signOptions);
    const refreshToken = sign({ ...payload, type: 'refresh' }, jwtConfig.refreshSecret, refreshOptions);

    return { accessToken, refreshToken };
  }

  private static async storeRefreshToken(userId: string, refreshToken: string): Promise<void> {
    const decoded = verify(refreshToken, jwtConfig.refreshSecret, {
      issuer: this.TOKEN_ISSUER,
      audience: this.TOKEN_AUDIENCE,
    }) as JwtPayload & { exp: number };

    await knex('refresh_tokens').insert({
      id: randomUUID(),
      user_id: userId,
      token: refreshToken,
      expires_at: new Date(decoded.exp! * 1000),
      revoked: false,
      created_at: new Date(),
    });
  }
}