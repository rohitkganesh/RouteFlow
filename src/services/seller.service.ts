import { knex } from '../config/database';
import { Seller, CreateSellerInput, UpdateSellerInput } from '../models';

export class SellerService {
  static async findById(sellerId: string): Promise<Seller | null> {
    return knex('sellers').where({ id: sellerId }).first() ?? null;
  }

  static async findByUserId(userId: string): Promise<Seller | null> {
    return knex('sellers').where({ user_id: userId }).first() ?? null;
  }

  /**
   * Get-or-create the seller profile for a given user. If a row already
   * exists in the sellers table for this user_id, return it. Otherwise,
   * create a default one. The frontend relies on this to make the
   * "Add Vehicle" / "New Route" / "Create Order" flows work even when
   * the user never explicitly filled in their business profile.
   */
  static async getOrCreateForUser(userId: string): Promise<Seller> {
    const existing = await this.findByUserId(userId);
    if (existing) return existing;
    const [created] = await knex('sellers')
      .insert({ user_id: userId, status: 'active' })
      .returning('*');
    return created;
  }

  static async create(input: CreateSellerInput): Promise<Seller> {
    const [row] = await knex('sellers')
      .insert({
        user_id: input.userId,
        business_name: input.businessName,
        business_type: input.businessType,
        business_email: input.businessEmail,
        business_phone: input.businessPhone,
        business_address: input.businessAddress,
        tax_id: input.taxId,
        license_number: input.licenseNumber,
        status: 'active',
      })
      .returning('*');
    return row;
  }

  static async update(sellerId: string, updates: UpdateSellerInput): Promise<Seller> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (updates.businessName !== undefined) updateData.business_name = updates.businessName;
    if (updates.businessType !== undefined) updateData.business_type = updates.businessType;
    if (updates.businessEmail !== undefined) updateData.business_email = updates.businessEmail;
    if (updates.businessPhone !== undefined) updateData.business_phone = updates.businessPhone;
    if (updates.businessAddress !== undefined) updateData.business_address = updates.businessAddress;
    if (updates.taxId !== undefined) updateData.tax_id = updates.taxId;
    if (updates.licenseNumber !== undefined) updateData.license_number = updates.licenseNumber;

    const [row] = await knex('sellers')
      .where({ id: sellerId })
      .update(updateData)
      .returning('*');
    return row;
  }

  static async listAll(options: { page?: number; limit?: number; status?: string } = {}): Promise<{ sellers: Seller[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    let countQuery = knex('sellers');
    if (options.status) countQuery = countQuery.where({ status: options.status });
    const totalRow = await countQuery.count('* as count').first();
    const total = Number(totalRow?.count ?? 0);

    let query = knex('sellers').orderBy('created_at', 'desc');
    if (options.status) query = query.where({ status: options.status });
    const sellers = await query.limit(limit).offset(offset);

    return { sellers, total };
  }

  /**
   * Convert a snake_case Seller row into the camelCase shape the frontend's
   * Seller type uses (businessName, businessAddress, etc.).
   */
  static toCamel(row: Seller | Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      userId: row.user_id ?? null,
      businessName: row.business_name ?? null,
      businessType: row.business_type ?? null,
      businessEmail: row.business_email ?? null,
      businessPhone: row.business_phone ?? null,
      businessAddress: row.business_address ?? null,
      taxId: row.tax_id ?? null,
      licenseNumber: row.license_number ?? null,
      status: String(row.status ?? 'active').toUpperCase(),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
