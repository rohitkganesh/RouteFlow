import { Router } from 'express';
import { body } from 'express-validator';
import { AuthController } from '../controllers/auth.controller';
import { authenticate, optionalAuth } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';

const router = Router();

router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8, max: 128 }).withMessage('Password must be 8-128 characters'),
    body('role')
      .optional()
      .customSanitizer((val) => (typeof val === 'string' ? val.toLowerCase() : val))
      .isIn(['admin', 'seller', 'driver'])
      .withMessage('Invalid role'),
    body('profileDetails').optional().isObject(),
  ],
  validate,
  AuthController.register
);

router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password required'),
  ],
  validate,
  AuthController.login
);

router.post(
  '/refresh',
  [body('refreshToken').optional().isString()],
  validate,
  AuthController.refresh
);

router.post('/logout', optionalAuth, AuthController.logout);

router.get('/me', authenticate, AuthController.me);

export default router;