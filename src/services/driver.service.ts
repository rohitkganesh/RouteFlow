import { knex } from '../config/database';
import { config } from '../config/env';
import { Driver, DriverAvailability, UpdateDriverLocationInput, UpdateDriverAvailabilityInput } from '../models';
import { NotFoundError, ValidationError } from '../utils/errors';
import { emitDriverLocation, emitDriverAvailability } from '../socket';
import { GeofenceService } from './geofence.service';
import { decryptObject } from '../config/encryption';

/**
 * Multiplier applied to haversine (straight-line) distance to approximate
 * road-network distance in SQL. Used so the `findNearbyDrivers` distance
 * reflects an actual road distance rather than the crow-fly distance.
 */
const ROAD_DISTANCE_FACTOR = config.ROUTING_ROAD_DISTANCE_FACTOR;

export class DriverService {
  static async getDriverByUserId(userId: string): Promise<Driver | null> {
    return knex('drivers').where({ user_id: userId }).first();
  }

  static async getDriverById(driverId: string): Promise<Driver | null> {
    return knex('drivers').where({ id: driverId }).first();
  }

  static async findNearbyDrivers(
    latitude: number,
    longitude: number,
    radiusKm: number,
    limit = 10
  ): Promise<Driver[]> {
    // Haversine distance in km — avoids the PostGIS dependency
    // 6371 = Earth's radius in km
    //
    // The straight-line haversine is scaled by ROAD_DISTANCE_FACTOR so
    // the radius filter and ordering reflect an approximate road-network
    // distance rather than the crow-fly distance. Roads wind through
    // streets; real road distance is typically ~1.25× the great-circle
    // distance in urban areas.
    const distanceExpr = `
      (
        ${ROAD_DISTANCE_FACTOR} * (
          2 * 6371 * asin(
            least(1.0, sqrt(
              power(sin(radians(current_latitude - ?) / 2), 2) +
              cos(radians(?)) *
              cos(radians(current_latitude)) *
              power(sin(radians(current_longitude - ?) / 2), 2)
            ))
          )
        )
      )
    `;

    return knex('drivers')
      .where({ availability_status: 'available' })
      .whereNotNull('current_latitude')
      .whereNotNull('current_longitude')
      .whereRaw(`${distanceExpr} <= ?`, [latitude, latitude, longitude, radiusKm])
      .orderByRaw(distanceExpr, [latitude, latitude, longitude])
      .limit(limit);
  }

  static async findByAvailability(status: DriverAvailability, limit = 50, offset = 0): Promise<Driver[]> {
    return knex('drivers').where({ availability_status: status }).limit(limit).offset(offset);
  }

  static async findByAvailabilityPaginated(
    status: DriverAvailability,
    options: { page?: number; limit?: number } = {}
  ): Promise<{ drivers: Driver[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    const totalResult = await knex('drivers').where({ availability_status: status }).count('* as count').first();
    const total = Number(totalResult?.count ?? 0);
    const drivers = await knex('drivers').where({ availability_status: status }).limit(limit).offset(offset);

    return { drivers, total: Number(total) };
  }

  static async updateDriverLocation(userId: string, input: UpdateDriverLocationInput): Promise<Driver> {
    const driver = await knex('drivers').where({ user_id: userId }).first();
    if (!driver) {
      throw new NotFoundError('Driver profile not found');
    }

    const [updated] = await knex('drivers')
      .where({ user_id: userId })
      .update({
        current_latitude: input.latitude,
        current_longitude: input.longitude,
        updated_at: new Date(),
      })
      .returning('*');

    // Emit real-time driver location update
    emitDriverLocation({
      driverId: updated.id,
      latitude: updated.current_latitude!,
      longitude: updated.current_longitude!,
      timestamp: new Date(),
    });

    // Auto-deliver: if the driver is now within the geofence radius
    // of any of their `on_the_way` orders' delivery coordinates,
    // transition those orders to `delivered`. Fire-and-forget — a
    // slow check must never delay the high-frequency location push.
    GeofenceService.checkOnLocationUpdate(updated.id, {
      latitude: updated.current_latitude!,
      longitude: updated.current_longitude!,
    }).catch((err) => {
      console.warn(`[driver] geofence check failed for driver ${updated.id}:`, err);
    });

    return updated;
  }

  static async updateDriverAvailability(userId: string, input: UpdateDriverAvailabilityInput): Promise<Driver> {
    const driver = await knex('drivers').where({ user_id: userId }).first();
    if (!driver) {
      throw new NotFoundError('Driver profile not found');
    }

    const [updated] = await knex('drivers')
      .where({ user_id: userId })
      .update({
        availability_status: input.availabilityStatus,
        updated_at: new Date(),
      })
      .returning('*');

    // Emit real-time driver availability update
    emitDriverAvailability(updated.id, updated.availability_status);

    return updated;
  }

  static async incrementWorkload(driverId: string): Promise<Driver> {
    const [driver] = await knex('drivers')
      .where({ id: driverId })
      .increment('current_workload', 1)
      .update({ updated_at: new Date() })
      .returning('*');

    if (!driver) {
      throw new NotFoundError('Driver not found');
    }

    return driver;
  }

  static async decrementWorkload(driverId: string): Promise<Driver> {
    const [driver] = await knex('drivers')
      .where({ id: driverId })
      .where('current_workload', '>', 0)
      .decrement('current_workload', 1)
      .update({ updated_at: new Date() })
      .returning('*');

    if (!driver) {
      throw new NotFoundError('Driver not found or workload already zero');
    }

    return driver;
  }

  static async createDriverProfile(userId: string): Promise<Driver> {
    const existing = await knex('drivers').where({ user_id: userId }).first();
    if (existing) {
      throw new ValidationError('Driver profile already exists for this user');
    }

    const [driver] = await knex('drivers')
      .insert({
        user_id: userId,
        availability_status: 'offline',
        current_workload: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');

    return driver;
  }

  static async getDriverCount(): Promise<number> {
    const result = await knex('drivers').count('* as count').first();
    return Number(result?.count ?? 0);
  }

  static async getDriverStats(): Promise<Record<DriverAvailability, number>> {
    const stats = await knex('drivers')
      .select('availability_status')
      .count('* as count')
      .groupBy('availability_status');

    const result: Record<DriverAvailability, number> = {
      available: 0,
      busy: 0,
      offline: 0,
    };

    for (const stat of stats) {
      result[stat.availability_status as DriverAvailability] = Number(stat.count);
    }

    return result;
  }

  /**
   * List drivers with their user info. The seller dashboard needs this to
   * populate the "assign driver" dropdown on the order detail page.
   * The result is shaped like the frontend's Driver type (id, user, isOnline, isAvailable, etc.).
   */
  static async listAll(
    options: { page?: number; limit?: number; isAvailable?: boolean } = {}
  ): Promise<{ drivers: Array<Record<string, unknown>>; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    let countQuery = knex('drivers');
    if (options.isAvailable !== undefined) {
      countQuery = countQuery.where({ availability_status: 'available' });
    }
    const totalRow = await countQuery.count('* as count').first();
    const total = Number(totalRow?.count ?? 0);

    let query = knex('drivers').orderBy('created_at', 'desc');
    if (options.isAvailable !== undefined) {
      query = query.where({ availability_status: 'available' });
    }
    const rows = await query.limit(limit).offset(offset);

    // Join user details for each driver.
    //
    // `users.profile_details` is encrypted at write time (see
    // `AuthService.register` / `UserService.update`), so the raw
    // JSONB column we read here is a string-valued object of
    // ciphertext. We must decrypt before exposing it; otherwise
    // the frontend driver dropdown shows the encrypted base64
    // text (e.g. "okb9ZcvtIkGHkZywAnqcg82MuvKKOds+td3385t+K7U=")
    // instead of the driver's firstName / lastName.
    const drivers = await Promise.all(
      rows.map(async (d) => {
        const user = await knex('users').where({ id: d.user_id }).first();
        const profileDetails = user?.profile_details
          ? decryptObject(user.profile_details as Record<string, unknown>)
          : {};
        return {
          id: d.id,
          userId: d.user_id,
          isAvailable: d.availability_status === 'available',
          isOnline: d.availability_status !== 'offline',
          availabilityStatus: d.availability_status,
          currentLatitude: d.current_latitude,
          currentLongitude: d.current_longitude,
          currentWorkload: d.current_workload,
          licenseExpiry: d.license_expiry ?? null,
          user: user
            ? {
                id: user.id,
                firstName: String(profileDetails.firstName ?? ''),
                lastName: String(profileDetails.lastName ?? ''),
                email: user.email,
                phone: String(profileDetails.phone ?? ''),
              }
            : undefined,
          vehicle: undefined, // populated later when vehicle assignment is wired
        };
      })
    );

    return { drivers, total };
  }
}