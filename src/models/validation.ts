import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  role: z.preprocess((val) => (typeof val === 'string' ? val.toLowerCase() : val), z.enum(['admin', 'seller', 'driver'])).default('seller'),
  profileDetails: z.object({
    firstName: z.string().min(1).max(50).optional(),
    lastName: z.string().min(1).max(50).optional(),
    phone: z.string().regex(/^\+?[1-9]\d{1,14}$/).optional().or(z.literal('')).transform(v => v === '' ? undefined : v),
    address: z.string().max(500).optional().or(z.literal('')).transform(v => v === '' ? undefined : v),
    avatarUrl: z.string().url().optional().or(z.literal('')).transform(v => v === '' ? undefined : v),
  }).optional(),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;