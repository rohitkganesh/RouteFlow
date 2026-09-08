import { Router } from 'express';
import { param, query } from 'express-validator';
import { PublicController } from '../controllers/public.controller';
import { validate } from '../middlewares/validate.middleware';

const router = Router();

/**
 * @route GET /api/public/track/:id
 * @description Public order tracking - no authentication required
 * @access Public
 */
router.get(
  '/track/:id',
  [
    param('id').isUUID().withMessage('Valid order ID required'),
  ],
  validate,
  PublicController.trackOrder
);

/**
 * @route GET /api/public/track/:id/history
 * @description Get order tracking history - no authentication required
 * @access Public
 */
router.get(
  '/track/:id/history',
  [
    param('id').isUUID().withMessage('Valid order ID required'),
  ],
  validate,
  PublicController.getOrderTrackingHistory
);

export default router;