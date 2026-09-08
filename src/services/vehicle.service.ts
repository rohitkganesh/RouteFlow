import { knex } from '../config/database';
import { Vehicle, CreateVehicleInput, UpdateVehicleInput } from '../models';
import { NotFoundError } from '../utils/errors';

export class VehicleService {
  static async create(input: CreateVehicleInput): Promise<Vehicle> {
    const [row] = await knex('vehicles')
      .insert({
        seller_id: input.sellerId,
        plate_number: input.plateNumber,
        type: input.type,
        brand: input.brand,
        model: input.model,
        year: input.year,
        color: input.color,
        capacity_weight: input.capacityWeight,
        capacity_volume: input.capacityVolume,
        fuel_type: input.fuelType,
        insurance_expiry: input.insuranceExpiry,
        registration_expiry: input.registrationExpiry,
        gps_device_id: input.gpsDeviceId,
        driver_id: input.driverId,
        status: 'active',
      })
      .returning('*');
    return row;
  }

  static async findById(id: string): Promise<Vehicle | null> {
    return knex('vehicles').where({ id }).first() ?? null;
  }

  static async listBySeller(
    sellerId: string,
    options: { page?: number; limit?: number; status?: string; type?: string } = {}
  ): Promise<{ vehicles: Vehicle[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    let countQuery = knex('vehicles').where({ seller_id: sellerId });
    if (options.status) countQuery = countQuery.where({ status: options.status });
    if (options.type) countQuery = countQuery.where({ type: options.type });
    const totalRow = await countQuery.count('* as count').first();
    const total = Number(totalRow?.count ?? 0);

    let query = knex('vehicles').where({ seller_id: sellerId }).orderBy('created_at', 'desc');
    if (options.status) query = query.where({ status: options.status });
    if (options.type) query = query.where({ type: options.type });
    const vehicles = await query.limit(limit).offset(offset);

    return { vehicles, total };
  }

  static async listAll(
    options: { page?: number; limit?: number; sellerId?: string; driverId?: string; status?: string; type?: string } = {}
  ): Promise<{ vehicles: Vehicle[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    let countQuery = knex('vehicles');
    if (options.sellerId) countQuery = countQuery.where({ seller_id: options.sellerId });
    if (options.driverId) countQuery = countQuery.where({ driver_id: options.driverId });
    if (options.status) countQuery = countQuery.where({ status: options.status });
    if (options.type) countQuery = countQuery.where({ type: options.type });
    const totalRow = await countQuery.count('* as count').first();
    const total = Number(totalRow?.count ?? 0);

    let query = knex('vehicles').orderBy('created_at', 'desc');
    if (options.sellerId) query = query.where({ seller_id: options.sellerId });
    if (options.driverId) query = query.where({ driver_id: options.driverId });
    if (options.status) query = query.where({ status: options.status });
    if (options.type) query = query.where({ type: options.type });
    const vehicles = await query.limit(limit).offset(offset);

    return { vehicles, total };
  }

  static async update(id: string, updates: UpdateVehicleInput): Promise<Vehicle> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (updates.plateNumber !== undefined) updateData.plate_number = updates.plateNumber;
    if (updates.type !== undefined) updateData.type = updates.type;
    if (updates.brand !== undefined) updateData.brand = updates.brand;
    if (updates.model !== undefined) updateData.model = updates.model;
    if (updates.year !== undefined) updateData.year = updates.year;
    if (updates.color !== undefined) updateData.color = updates.color;
    if (updates.capacityWeight !== undefined) updateData.capacity_weight = updates.capacityWeight;
    if (updates.capacityVolume !== undefined) updateData.capacity_volume = updates.capacityVolume;
    if (updates.fuelType !== undefined) updateData.fuel_type = updates.fuelType;
    if (updates.insuranceExpiry !== undefined) updateData.insurance_expiry = updates.insuranceExpiry;
    if (updates.registrationExpiry !== undefined) updateData.registration_expiry = updates.registrationExpiry;
    if (updates.gpsDeviceId !== undefined) updateData.gps_device_id = updates.gpsDeviceId;
    if (updates.driverId !== undefined) updateData.driver_id = updates.driverId;
    if (updates.status !== undefined) updateData.status = updates.status;

    const [row] = await knex('vehicles')
      .where({ id })
      .update(updateData)
      .returning('*');
    if (!row) throw new NotFoundError('Vehicle not found');
    return row;
  }

  static async delete(id: string): Promise<void> {
    const deleted = await knex('vehicles').where({ id }).del();
    if (!deleted) throw new NotFoundError('Vehicle not found');
  }
}
