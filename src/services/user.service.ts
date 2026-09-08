import { knex } from '../config/database';
import { encryptObject, decryptObject } from '../config/encryption';
import { User, UserRole, UserProfileDetails, CreateUserInput } from '../models';
import { AuthError } from './auth.service.js';

export class UserService {
  static async findById(userId: string): Promise<Omit<User, 'password_hash'> | null> {
    const user = await knex('users').where({ id: userId }).first();
    if (!user) return null;
    return { ...user, profile_details: decryptObject(user.profile_details) };
  }

  static async findByEmail(email: string): Promise<User | null> {
    return knex('users').where({ email: email.toLowerCase() }).first();
  }

  static async findByRole(role: UserRole, limit = 50, offset = 0): Promise<Omit<User, 'password_hash'>[]> {
    const users = await knex('users').where({ role }).limit(limit).offset(offset);
    return users.map(u => ({ ...u, profile_details: decryptObject(u.profile_details) }));
  }

  static async findByRolePaginated(
    role: UserRole,
    options: { page?: number; limit?: number } = {}
  ): Promise<{ users: Omit<User, 'password_hash'>[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    const totalResult = await knex('users').where({ role }).count('* as count').first();
    const total = Number(totalResult?.count ?? 0);
    const users = await knex('users').where({ role }).limit(limit).offset(offset);

    return {
      users: users.map(u => ({ ...u, profile_details: decryptObject(u.profile_details) })),
      total,
    };
  }

  static async updateProfile(userId: string, updates: Partial<UserProfileDetails>): Promise<Omit<User, 'password_hash'>> {
    const user = await knex('users').where({ id: userId }).first();
    if (!user) {
      throw new AuthError('User not found', 'USER_NOT_FOUND', 404);
    }

    const currentProfile = decryptObject(user.profile_details);
    const mergedProfile = { ...currentProfile, ...updates };
    const encryptedProfile = encryptObject(mergedProfile);

    const [updated] = await knex('users')
      .where({ id: userId })
      .update({ profile_details: encryptedProfile, updated_at: new Date() })
      .returning(['id', 'email', 'role', 'profile_details', 'created_at', 'updated_at']);

    return { ...updated, profile_details: decryptObject(updated.profile_details) };
  }

  static async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await knex('users').where({ id: userId }).first();
    if (!user) {
      throw new AuthError('User not found', 'USER_NOT_FOUND', 404);
    }

    const { compare, hash } = await import('bcrypt');
    const { config } = await import('../config/env.js');

    const isValid = await compare(currentPassword, user.password_hash);
    if (!isValid) {
      throw new AuthError('Current password is incorrect', 'INVALID_PASSWORD', 401);
    }

    const newHash = await hash(newPassword, config.BCRYPT_ROUNDS);
    await knex('users').where({ id: userId }).update({ password_hash: newHash, updated_at: new Date() });
  }

  static async deleteUser(userId: string): Promise<void> {
    await knex('users').where({ id: userId }).del();
  }

  static async getUserCountByRole(role: UserRole): Promise<number> {
    const result = await knex('users').where({ role }).count('* as count').first();
    return Number(result?.count ?? 0);
  }
}