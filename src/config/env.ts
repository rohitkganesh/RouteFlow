import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('routeflow'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  ENCRYPTION_KEY: z.string().min(44), // base64 encoded 32 bytes
  ENCRYPTION_IV_LENGTH: z.coerce.number().default(12),

  BCRYPT_ROUNDS: z.coerce.number().default(12),

  CORS_ORIGIN: z.string().optional(),

  // Routing API Configuration
  // Default is `osrm` — the free public OSRM API (router.project-osrm.org)
  // returns real road-network distances + ETAs without an API key. Use
  // `mock` only for offline/unit tests where network calls are undesirable.
  ROUTING_PROVIDER: z.enum(['google', 'osrm', 'mock']).default('osrm'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  OSRM_BASE_URL: z.string().url().default('http://router.project-osrm.org'),
  ROUTING_MOCK_DELAY_MS: z.coerce.number().default(100),
  // Multiplier applied to haversine (straight-line) distance to approximate
  // road-network distance. Roads rarely follow a straight line, so real
  // road distance is typically 1.2–1.4× the great-circle distance in
  // urban/suburban areas. The MockRoutingProvider applies this factor so
  // even offline mode produces road-like distances instead of straight-line.
  // OSRM/Google providers return real road distances and ignore this factor.
  ROUTING_ROAD_DISTANCE_FACTOR: z.coerce.number().default(1.25),

  // Twilio Configuration (SMS)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().optional(),

  // Email Configuration (Nodemailer/SMTP)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  // Friendly aliases — if the operator fills in EMAIL_USER /
  // EMAIL_PASS instead of SMTP_USER / SMTP_PASSWORD, we treat
  // them as the SMTP credentials. SMTP_* still wins if both
  // are set, so legacy deployments don't break.
  EMAIL_USER: z.string().optional(),
  EMAIL_PASS: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().optional(),
  SMTP_FROM_NAME: z.string().optional(),

  // Public App URL (for tracking links)
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),

  // Auto-assign tuning — caps how many active orders a single driver can
  // hold before they're skipped by the matching algorithm, and the km
  // penalty that each unit of current workload adds to the driver's score
  // (so a driver 4 km away with 0 orders beats one 1 km away with 5).
  MAX_DRIVER_WORKLOAD: z.coerce.number().default(5),
  WORKLOAD_DISTANCE_PENALTY_KM: z.coerce.number().default(2),

  // Geofencing: when a driver pushes a location within this many
  // meters of an order's delivery coordinate (and the order is in
  // 'on_the_way' status), the backend auto-transitions it to
  // 'delivered'. Set to 0 to disable. Read at call-time in
  // GeofenceService so tests can override the value.
  GEOFENCE_DELIVERY_RADIUS_METERS: z.coerce.number().default(50),

  // Driver earnings: a per-delivery base rate plus a per-km rate
  // applied to the route distance. The customer's `delivery_fee`
  // is the seller's revenue from shipping; the driver's earning
  // is computed independently from this rate model so order
  // pricing and driver payouts stay decoupled.
  //
  //   driverEarning = DRIVER_BASE_RATE + (distance_km * DRIVER_PER_KM_RATE)
  //
  // Both values are in the seller's currency (USD here). Tune in
  // .env / .env.test without redeploying code.
  DRIVER_BASE_RATE: z.coerce.number().default(2.0),
  DRIVER_PER_KM_RATE: z.coerce.number().default(0.5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const isProduction = config.NODE_ENV === 'production';
export const isDevelopment = config.NODE_ENV === 'development';
export const isTest = config.NODE_ENV === 'test';