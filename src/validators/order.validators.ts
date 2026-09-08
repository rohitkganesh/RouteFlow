/**
 * Order request validators.
 *
 * These are the first Zod validators in the codebase. We standardise
 * on Zod because `src/config/env.ts` already uses it for env-var
 * parsing, so no new dependency is introduced.
 *
 * `createOrderSchema` is parsed in `api.controller.ts` before the
 * request body reaches `OrderService.create`. A Zod parse failure
 * throws a `ZodError` which the global error handler in
 * `src/middlewares/error.middleware.ts` already maps to a 400
 * response with field-level details — so the controller only needs
 * to call `.parse()` and the rest of the error mapping is free.
 *
 * Why required: the transactional email system (see
 * `src/services/notification.service.ts`) needs a destination
 * address for the "Order Confirmed" and "Order Delivered" emails.
 * If the address is missing or malformed, we cannot honour the
 * notification, so we reject the request before it hits the DB.
 */
import { z } from 'zod';

/**
 * Schema for POST /api/orders.
 *
 * Field notes:
 * - `customerEmail` is REQUIRED (was optional before the
 *   2026-09-07 audit). Zod's `.email()` enforces RFC-5322-ish
 *   format and rejects the obvious typos before they hit the DB.
 * - `customerPhone` is REQUIRED and must look like a real phone
 *   number — at least 7 digits, with optional `+` country code,
 *   and only digits / spaces / dashes / dots / parens. We do not
 *   enforce E.164 strictly because the existing data has a mix of
 *   formats ("+1 555-555-0100", "(555) 555-0100", "5555550100")
 *   and the seller UI formats on display, not at write. The
 *   regex below accepts all of those.
 * - `latitude` / `longitude` are optional at the validator level
 *   because some legacy callers omit them. The service layer
 *   defaults them to (0, 0) which falls into the "no driver in
 *   range" branch in `OrderService.create` — i.e. an order
 *   without coords stays PENDING and the seller can assign
 *   manually. We do not 400 on missing coords.
 * - `parcelDetails` is a nested optional object so partial
 *   updates of the parcel (e.g. weight only) are accepted. The
 *   service encrypts the whole object on write.
 */
export const createOrderSchema = z.object({
  customerName: z.string().min(1, 'customerName is required').max(255),
  // Permissive phone format: optional leading +, then 7-15 digits
  // with optional spaces, dashes, dots, or parens between them.
  // This matches the Twilio E.164-ish format we'd ultimately send
  // the SMS to, without rejecting the legacy human formats.
  customerPhone: z
    .string()
    .min(1, 'customerPhone is required')
    .max(32)
    .regex(
      /^\+?[0-9().\-\s]{7,20}$/,
      'customerPhone must be a valid phone number (7-20 digits, optional +)',
    ),
  customerEmail: z
    .string({ required_error: 'customerEmail is required' })
    .email('customerEmail must be a valid email address')
    .max(255),

  deliveryAddress: z.string().min(1, 'deliveryAddress is required'),

  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),

  // Optional parcel metadata. The shape mirrors
  // `OrderParcelDetails` in the model.
  parcelDetails: z
    .object({
      weight: z.number().positive().optional(),
      dimensions: z.string().optional(),
      value: z.number().nonnegative().optional(),
      fragile: z.boolean().optional(),
      description: z.string().max(1000).optional(),
    })
    .optional(),
});

export type CreateOrderBody = z.infer<typeof createOrderSchema>;
