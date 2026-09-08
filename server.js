// server.js - RouteFlow Backend (Updated for Frontend Compatibility)
// Simple Express.js server with PostgreSQL, bcrypt, and JWT authentication

// ============================================
// 1. IMPORTS & CONFIGURATION
// ============================================

const express = require('express');
const { Pool } = require('pg');           // PostgreSQL client
const bcrypt = require('bcrypt');         // Password hashing
const jwt = require('jsonwebtoken');      // JWT token generation
const cors = require('cors');             // Allow frontend to call API

const app = express();
const PORT = 3001;                        // Frontend expects API on port 3001

// Secret keys (in production, use environment variables!)
const JWT_SECRET = 'routeflow_super_secret_key_2026';
const REFRESH_SECRET = 'routeflow_refresh_secret_2026';

// Token expiration times
const ACCESS_TOKEN_EXPIRY = '15m';        // Short-lived access token
const REFRESH_TOKEN_EXPIRY = '7d';        // Long-lived refresh token

// Middleware
app.use(express.json());
app.use(cors({
  origin: 'http://localhost:3000',        // Frontend URL
  credentials: true
}));

// ============================================
// 2. DATABASE CONNECTION POOL
// ============================================

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'routeflow',
  password: 'postgres',
  port: 5432,
  max: 10,
  idleTimeoutMillis: 30000
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected at:', res.rows[0].now);
  }
});

// ============================================
// 3. HELPER FUNCTIONS
// ============================================

// Query wrapper with logging
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('📊 Query:', { text: text.substring(0, 60) + '...', duration: duration + 'ms', rows: result.rowCount });
    return result;
  } catch (error) {
    console.error('❌ Query error:', error.message);
    throw error;
  }
}

// Generate access token (short-lived)
function generateAccessToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

// Generate refresh token (long-lived)
function generateRefreshToken(user) {
  return jwt.sign(
    { userId: user.id, type: 'refresh' },
    REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

// Verify refresh token
function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

// Middleware to authenticate access token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      message: 'Access token required'
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: 'Invalid or expired token'
      });
    }
    req.user = user; // { userId, email, role, iat, exp }
    next();
  });
}

// ============================================
// 4. AUTH ROUTES (Frontend-compatible)
// ============================================

/*
  POST /api/auth/register
  Expected body:
  {
    "email": "john@example.com",
    "password": "securePassword123",
    "firstName": "John",
    "lastName": "Doe",
    "phone": "+1234567890",      // optional
    "role": "SELLER"             // optional, defaults to SELLER (ADMIN, SELLER, DRIVER)
  }
*/
app.post('/api/auth/register', async (req, res) => {
  try {
    // 1. Extract and validate input
    // Frontend sends: { email, password, role, profileDetails: { firstName, lastName, phone } }
    const { email, password, role } = req.body;
    const profileDetails = req.body.profileDetails || {};
    const firstName = profileDetails.firstName || req.body.firstName || '';
    const lastName = profileDetails.lastName || req.body.lastName || '';
    const phone = profileDetails.phone || req.body.phone || null;

    // Required fields
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Email, password, firstName, and lastName are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Invalid email format'
      });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Password must be at least 8 characters'
      });
    }

    // Validate role (DB enum is uppercase: ADMIN, SELLER, DRIVER)
    const validRoles = ['ADMIN', 'SELLER', 'DRIVER'];
    const userRole = role && validRoles.includes(role.toUpperCase()) ? role.toUpperCase() : 'SELLER';

    // 2. Check if user already exists
    const existingUser = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        code: 'CONFLICT',
        message: 'User with this email already exists'
      });
    }

    // 3. Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    console.log('🔐 Password hashed for:', email);

    // 4. Build profile_details JSONB
    const profile = JSON.stringify({
      firstName,
      lastName,
      phone: phone || null,
      avatarUrl: null,
      preferences: {}
    });

    // 5. Insert new user - include first_name and last_name columns (required NOT NULL in schema)
    const insertResult = await query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone, profile_details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       RETURNING id, email, role, first_name, last_name, phone, profile_details, created_at`,
      [email.toLowerCase(), passwordHash, userRole, firstName, lastName, phone, profile]
    );

    const newUser = insertResult.rows[0];
    console.log('✅ User registered:', newUser.email, 'Role:', newUser.role);

    // 6. Generate tokens
    const accessToken = generateAccessToken(newUser);
    const refreshToken = generateRefreshToken(newUser);

    // 7. Store refresh token in refresh_tokens table
    const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at, revoked) VALUES ($1, $2, $3, false)`,
      [newUser.id, refreshToken, refreshExpiry]
    );

    // 8. Return response in format frontend expects
    const pd = newUser.profile_details || {};
    const userResponse = {
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      profile_details: newUser.profile_details,
      created_at: newUser.created_at,
      // Flattened fields for frontend normalizeBackendUser
      firstName: pd.firstName || newUser.first_name || '',
      lastName: pd.lastName || newUser.last_name || '',
      phone: pd.phone || newUser.phone || null,
      avatarUrl: pd.avatarUrl || null,
    };

    res.status(201).json({
      success: true,
      data: {
        user: userResponse,
        accessToken,
        refreshToken,
        expiresIn: 15 * 60
      }
    });

  } catch (error) {
    console.error('❌ Registration error:', error.message);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error during registration'
    });
  }
});

/*
  POST /api/auth/login
  Expected body:
  {
    "email": "john@example.com",
    "password": "securePassword123",
    "rememberMe": true,          // optional
    "twoFactorCode": "123456"    // optional
  }
*/
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Email and password are required'
      });
    }

    // 2. Fetch user from database (actual schema)
    const result = await query(
      `SELECT id, email, password_hash, role, profile_details, created_at FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password'
      });
    }

    const user = result.rows[0];

    // 3. Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password'
      });
    }

    // 4. Generate tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // 5. Store refresh token in refresh_tokens table
    //    First, delete old tokens for this user to keep things clean
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
    const refreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at, revoked) VALUES ($1, $2, $3, false)`,
      [user.id, refreshToken, refreshExpiry]
    );

    console.log('✅ User logged in:', user.email);

    // 6. Return response in frontend-expected format
    const pd = user.profile_details || {};
    const userResponse = {
      id: user.id,
      email: user.email,
      role: user.role,
      profile_details: user.profile_details,
      created_at: user.created_at,
      // Flattened fields for frontend normalizeBackendUser
      firstName: pd.firstName || '',
      lastName: pd.lastName || '',
      phone: pd.phone || null,
      avatarUrl: pd.avatarUrl || null,
    };

    res.json({
      success: true,
      data: {
        user: userResponse,
        accessToken,
        refreshToken,
        expiresIn: 15 * 60
      }
    });

  } catch (error) {
    console.error('❌ Login error:', error.message);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error during login'
    });
  }
});

/*
  POST /api/auth/refresh
  Expected body:
  {
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
*/
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Refresh token is required'
      });
    }

    // 1. Verify refresh token signature
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Invalid refresh token'
      });
    }

    // 2. Check refresh token exists in refresh_tokens table and is not revoked/expired
    const tokenResult = await query(
      `SELECT rt.id, rt.expires_at, rt.revoked,
              u.id as user_id, u.email, u.role, u.profile_details, u.created_at
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token = $1 AND rt.user_id = $2`,
      [refreshToken, decoded.userId]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Invalid refresh token'
      });
    }

    const tokenRow = tokenResult.rows[0];

    if (tokenRow.revoked) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Refresh token has been revoked'
      });
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      return res.status(401).json({
        success: false,
        code: 'TOKEN_EXPIRED',
        message: 'Refresh token expired. Please login again.'
      });
    }

    const user = {
      id: tokenRow.user_id,
      email: tokenRow.email,
      role: tokenRow.role,
      profile_details: tokenRow.profile_details,
      created_at: tokenRow.created_at
    };

    // 3. Rotate tokens — delete old, issue new
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    await query('DELETE FROM refresh_tokens WHERE id = $1', [tokenRow.id]);
    const newRefreshExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at, revoked) VALUES ($1, $2, $3, false)`,
      [user.id, newRefreshToken, newRefreshExpiry]
    );

    // 4. Return new tokens
    const pd = user.profile_details || {};
    res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresIn: 15 * 60
      }
    });

  } catch (error) {
    console.error('❌ Token refresh error:', error.message);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error during token refresh'
    });
  }
});

/*
  GET /api/users/me
  Protected route - requires valid access token in Authorization header
*/
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, email, role, profile_details, created_at FROM users WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: 'User not found'
      });
    }

    const user = result.rows[0];
    const pd = user.profile_details || {};

    // Return in the shape that normalizeBackendUser() in api.ts expects:
    // { id, email, role, profile_details: { firstName, lastName, phone, avatarUrl } }
    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          profile_details: user.profile_details,
          created_at: user.created_at,
        }
      }
    });

  } catch (error) {
    console.error('❌ Get profile error:', error.message);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

/*
  POST /api/auth/logout
  Invalidate refresh token
*/
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    // Revoke all refresh tokens for this user
    await query(
      'DELETE FROM refresh_tokens WHERE user_id = $1',
      [req.user.userId]
    );

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('❌ Logout error:', error.message);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Error during logout'
    });
  }
});

// ============================================
// 5. HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'RouteFlow API'
  });
});

// ============================================
// 6. SELLER ROUTES
// ============================================

// GET /api/sellers/me - Get current user's seller profile
app.get('/api/sellers/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT s.*, u.email, u.first_name, u.last_name, u.phone, u.role, u.status
       FROM sellers s
       JOIN users u ON s.user_id = u.id
       WHERE s.user_id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: 'Seller profile not found'
      });
    }

    const seller = result.rows[0];
    res.json({
      success: true,
      data: {
        id: seller.id,
        userId: seller.user_id,
        businessName: seller.business_name,
        businessType: seller.business_type,
        businessAddress: seller.business_address,
        businessPhone: seller.business_phone,
        businessEmail: seller.business_email,
        taxId: seller.tax_id,
        licenseNumber: seller.license_number,
        commissionRate: parseFloat(seller.commission_rate),
        monthlyVolume: seller.monthly_volume,
        rating: parseFloat(seller.rating),
        totalOrders: seller.total_orders,
        completedOrders: seller.completed_orders,
        cancelledOrders: seller.cancelled_orders,
        isVerified: seller.is_verified,
        verifiedAt: seller.verified_at,
        verifiedBy: seller.verified_by,
        settings: seller.settings,
        createdAt: seller.created_at,
        updatedAt: seller.updated_at,
        deletedAt: seller.deleted_at,
        user: {
          email: seller.email,
          firstName: seller.first_name,
          lastName: seller.last_name,
          phone: seller.phone,
          role: seller.role,
          status: seller.status
        }
      }
    });
  } catch (error) {
    console.error('❌ Get seller error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// POST /api/sellers - Create seller profile
app.post('/api/sellers', authenticateToken, async (req, res) => {
  try {
    const { businessName, businessType, businessAddress, businessPhone, businessEmail, taxId, licenseNumber, commissionRate, settings } = req.body;

    if (!businessName) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'businessName is required' });
    }

    // Check if seller already exists for this user
    const existing = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, code: 'CONFLICT', message: 'Seller profile already exists' });
    }

    const result = await query(
      `INSERT INTO sellers (user_id, business_name, business_type, business_address, business_phone, business_email, tax_id, license_number, commission_rate, settings, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       RETURNING *`,
      [req.user.userId, businessName, businessType, businessAddress, businessPhone, businessEmail, taxId, licenseNumber, commissionRate || 10.00, JSON.stringify(settings || {})]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Create seller error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// GET /api/sellers/me/stats - Get seller statistics
app.get('/api/sellers/me/stats', authenticateToken, async (req, res) => {
  try {
    // Get seller ID first
    const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (sellerResult.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Seller not found' });
    }
    const sellerId = sellerResult.rows[0].id;

    // Aggregate stats
    const statsResult = await query(
      `SELECT
         COUNT(*) as total_orders,
         COUNT(*) FILTER (WHERE status = 'DELIVERED') as completed_orders,
         COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_orders,
         COUNT(*) FILTER (WHERE status IN ('PENDING', 'CONFIRMED', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT')) as pending_orders,
         COALESCE(SUM(total_amount) FILTER (WHERE payment_status = 'PAID'), 0) as total_revenue,
         COALESCE(AVG(total_amount) FILTER (WHERE payment_status = 'PAID'), 0) as avg_order_value
       FROM orders WHERE seller_id = $1`,
      [sellerId]
    );

    const stats = statsResult.rows[0];
    res.json({
      success: true,
      data: {
        totalOrders: parseInt(stats.total_orders),
        completedOrders: parseInt(stats.completed_orders),
        cancelledOrders: parseInt(stats.cancelled_orders),
        pendingOrders: parseInt(stats.pending_orders),
        totalRevenue: parseFloat(stats.total_revenue),
        avgOrderValue: parseFloat(stats.avg_order_value),
        avgDeliveryTime: 0, // TODO: calculate from order tracking
        driverUtilization: 0, // TODO: calculate from driver assignments
        customerRating: 0 // TODO: calculate from ratings
      }
    });
  } catch (error) {
    console.error('❌ Seller stats error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// ============================================
// 7. DRIVER ROUTES
// ============================================

// GET /api/drivers/me - Get current user's driver profile
app.get('/api/drivers/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT d.*, u.email, u.first_name, u.last_name, u.phone, u.role, u.status
       FROM drivers d
       JOIN users u ON d.user_id = u.id
       WHERE d.user_id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Driver profile not found' });
    }

    const driver = result.rows[0];
    res.json({
      success: true,
      data: {
        id: driver.id,
        userId: driver.user_id,
        licenseNumber: driver.license_number,
        licenseExpiry: driver.license_expiry,
        licenseType: driver.license_type,
        vehicleType: driver.vehicle_type,
        vehicleId: driver.vehicle_id,
        currentLat: driver.current_lat ? parseFloat(driver.current_lat) : null,
        currentLng: driver.current_lng ? parseFloat(driver.current_lng) : null,
        lastLocationUpdate: driver.last_location_update,
        isAvailable: driver.is_available,
        isOnline: driver.is_online,
        currentRouteId: driver.current_route_id,
        rating: parseFloat(driver.rating),
        totalDeliveries: driver.total_deliveries,
        successfulDeliveries: driver.successful_deliveries,
        failedDeliveries: driver.failed_deliveries,
        totalEarnings: parseFloat(driver.total_earnings),
        pendingEarnings: parseFloat(driver.pending_earnings),
        lastActiveAt: driver.last_active_at,
        shiftStartTime: driver.shift_start_time,
        shiftEndTime: driver.shift_end_time,
        createdAt: driver.created_at,
        updatedAt: driver.updated_at,
        deletedAt: driver.deleted_at,
        user: {
          email: driver.email,
          firstName: driver.first_name,
          lastName: driver.last_name,
          phone: driver.phone,
          role: driver.role,
          status: driver.status
        }
      }
    });
  } catch (error) {
    console.error('❌ Get driver error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// PATCH /api/drivers/me/status - Update driver online/available status
app.patch('/api/drivers/me/status', authenticateToken, async (req, res) => {
  try {
    const { isOnline, isAvailable } = req.body;

    const updates = [];
    const params = [req.user.userId];
    let paramIndex = 2;

    if (typeof isOnline === 'boolean') {
      updates.push(`is_online = $${paramIndex++}`);
      params.push(isOnline);
    }
    if (typeof isAvailable === 'boolean') {
      updates.push(`is_available = $${paramIndex++}`);
      params.push(isAvailable);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'No valid fields to update' });
    }

    updates.push('updated_at = NOW()');
    const queryText = `UPDATE drivers SET ${updates.join(', ')} WHERE user_id = $1 RETURNING *`;

    const result = await query(queryText, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Driver not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Update driver status error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// POST /api/drivers/me/location - Update driver location
app.post('/api/drivers/me/location', authenticateToken, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'lat and lng are required numbers' });
    }

    await query(
      `UPDATE drivers SET current_lat = $1, current_lng = $2, last_location_update = NOW(), last_active_at = NOW() WHERE user_id = $3`,
      [lat, lng, req.user.userId]
    );

    res.json({ success: true, message: 'Location updated' });
  } catch (error) {
    console.error('❌ Update driver location error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// GET /api/drivers/me/stats - Get driver statistics
app.get('/api/drivers/me/stats', authenticateToken, async (req, res) => {
  try {
    const driverResult = await query('SELECT id FROM drivers WHERE user_id = $1', [req.user.userId]);
    if (driverResult.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Driver not found' });
    }
    const driverId = driverResult.rows[0].id;

    const statsResult = await query(
      `SELECT
         COUNT(*) as total_deliveries,
         COUNT(*) FILTER (WHERE status = 'DELIVERED') as successful_deliveries,
         COUNT(*) FILTER (WHERE status = 'FAILED') as failed_deliveries,
         COALESCE(SUM(total_amount), 0) as total_earnings,
         COALESCE(AVG(rating), 0) as avg_rating
       FROM tasks WHERE driver_id = $1`,
      [driverId]
    );

    const stats = statsResult.rows[0];
    res.json({
      success: true,
      data: {
        totalDeliveries: parseInt(stats.total_deliveries),
        successfulDeliveries: parseInt(stats.successful_deliveries),
        failedDeliveries: parseInt(stats.failed_deliveries),
        totalEarnings: parseFloat(stats.total_earnings),
        pendingEarnings: 0,
        avgRating: parseFloat(stats.avg_rating),
        onTimeRate: 0,
        avgDeliveryTime: 0,
        currentStreak: 0
      }
    });
  } catch (error) {
    console.error('❌ Driver stats error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// GET /api/drivers/available - Get available drivers (for assignment)
app.get('/api/drivers/available', authenticateToken, async (req, res) => {
  try {
    const { lat, lng, radius, vehicleType } = req.query;

    let queryText = `
      SELECT d.*, u.first_name, u.last_name, u.phone
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      WHERE d.is_online = true AND d.is_available = true
    `;
    const params = [];

    if (vehicleType) {
      params.push(vehicleType);
      queryText += ` AND d.vehicle_type = $${params.length}`;
    }

    // Add location filter if provided
    if (lat && lng && radius) {
      params.push(lat, lng, radius);
      queryText += `
        AND d.current_lat IS NOT NULL
        AND d.current_lng IS NOT NULL
        AND ST_DWithin(
          ST_MakePoint(d.current_lng, d.current_lat)::geography,
          ST_MakePoint($${params.length - 1}, $${params.length - 2})::geography,
          $${params.length} * 1000
        )
      `;
    }

    queryText += ' ORDER BY d.rating DESC LIMIT 50';

    const result = await query(queryText, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Get available drivers error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// ============================================
// 8. VEHICLE ROUTES
// ============================================

// GET /api/vehicles/my - Get vehicles for current seller
app.get('/api/vehicles/my', authenticateToken, async (req, res) => {
  try {
    // Get seller ID
    const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (sellerResult.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Seller not found' });
    }
    const sellerId = sellerResult.rows[0].id;

    const result = await query(
      `SELECT * FROM vehicles WHERE seller_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [sellerId]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Get my vehicles error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// POST /api/vehicles - Create vehicle
app.post('/api/vehicles', authenticateToken, async (req, res) => {
  try {
    const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (sellerResult.rows.length === 0) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Only sellers can create vehicles' });
    }
    const sellerId = sellerResult.rows[0].id;

    const { plateNumber, type, brand, model, year, color, capacityWeight, capacityVolume, fuelType, insuranceExpiry, registrationExpiry, gpsDeviceId } = req.body;

    if (!plateNumber || !type || !brand || !model || !year || !capacityWeight || !capacityVolume) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Required fields missing' });
    }

    const result = await query(
      `INSERT INTO vehicles (seller_id, plate_number, type, brand, model, year, color, capacity_weight, capacity_volume, fuel_type, insurance_expiry, registration_expiry, gps_device_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
       RETURNING *`,
      [sellerId, plateNumber, type, brand, model, year, color, capacityWeight, capacityVolume, fuelType, insuranceExpiry, registrationExpiry, gpsDeviceId]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Create vehicle error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// PATCH /api/vehicles/:id/assign-driver - Assign driver to vehicle
app.patch('/api/vehicles/:id/assign-driver', authenticateToken, async (req, res) => {
  try {
    const { driverId } = req.body;
    const vehicleId = req.params.id;

    // Verify vehicle belongs to seller
    const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (sellerResult.rows.length === 0) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Not authorized' });
    }
    const sellerId = sellerResult.rows[0].id;

    const result = await query(
      `UPDATE vehicles SET driver_id = $1, updated_at = NOW() WHERE id = $2 AND seller_id = $3 RETURNING *`,
      [driverId, vehicleId, sellerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Vehicle not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Assign driver error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// ============================================
// 9. ROUTE ROUTES
// ============================================

// GET /api/routes/my - Get routes for current seller
app.get('/api/routes/my', authenticateToken, async (req, res) => {
  try {
    const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (sellerResult.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Seller not found' });
    }
    const sellerId = sellerResult.rows[0].id;

    const { status, page = 1, limit = 20 } = req.query;
    let queryText = `SELECT * FROM routes WHERE seller_id = $1 AND deleted_at IS NULL`;
    const params = [sellerId];

    if (status) {
      params.push(status);
      queryText += ` AND status = $${params.length}`;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const result = await query(queryText, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Get my routes error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// POST /api/routes - Create route
app.post('/api/routes', authenticateToken, async (req, res) => {
  try {
    const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (sellerResult.rows.length === 0) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Only sellers can create routes' });
    }
    const sellerId = sellerResult.rows[0].id;

    const { name, description, startLocation, endLocation, waypoints, driverId, vehicleId } = req.body;

    if (!name || !startLocation || !endLocation) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'name, startLocation, endLocation required' });
    }

    const result = await query(
      `INSERT INTO routes (seller_id, name, description, start_location, end_location, waypoints, driver_id, vehicle_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', NOW(), NOW())
       RETURNING *`,
      [sellerId, name, description, JSON.stringify(startLocation), JSON.stringify(endLocation), JSON.stringify(waypoints || []), driverId, vehicleId]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Create route error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// POST /api/routes/optimize - Optimize route
app.post('/api/routes/optimize', authenticateToken, async (req, res) => {
  try {
    const { routeId, algorithm = 'NEAREST_NEIGHBOR', constraints } = req.body;

    if (!routeId) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'routeId required' });
    }

    // Fetch route with waypoints
    const routeResult = await query('SELECT * FROM routes WHERE id = $1', [routeId]);
    if (routeResult.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Route not found' });
    }

    const route = routeResult.rows[0];
    const waypoints = route.waypoints || [];

    // Simple nearest neighbor optimization (placeholder)
    // In production, use OR-Tools, genetic algorithm, etc.
    let optimizedWaypoints = [...waypoints];
    let totalDistance = 0;
    let estimatedDuration = 0;

    if (waypoints.length > 1) {
      // Simple optimization: sort by distance from start
      const start = route.start_location;
      optimizedWaypoints.sort((a, b) => {
        const distA = Math.sqrt(Math.pow(a.lat - start.lat, 2) + Math.pow(a.lng - start.lng, 2));
        const distB = Math.sqrt(Math.pow(b.lat - start.lat, 2) + Math.pow(b.lng - start.lng, 2));
        return distA - distB;
      });

      // Calculate total distance
      let prev = start;
      for (const wp of optimizedWaypoints) {
        totalDistance += Math.sqrt(Math.pow(wp.lat - prev.lat, 2) + Math.pow(wp.lng - prev.lng, 2)) * 111; // rough km
        prev = wp;
      }
      // Return to end
      totalDistance += Math.sqrt(Math.pow(route.end_location.lat - prev.lat, 2) + Math.pow(route.end_location.lng - prev.lng, 2)) * 111;
      estimatedDuration = Math.round(totalDistance * 2 * 60); // ~30 km/h average
    }

    // Update route with optimization
    await query(
      `UPDATE routes SET optimized_waypoints = $1, total_distance = $2, estimated_duration = $3, optimization_algorithm = $4, optimization_score = $5, updated_at = NOW() WHERE id = $6`,
      [JSON.stringify(optimizedWaypoints), totalDistance.toFixed(2), estimatedDuration, algorithm, 85.0, routeId]
    );

    res.json({
      success: true,
      data: {
        optimizedWaypoints,
        totalDistance: parseFloat(totalDistance.toFixed(2)),
        estimatedDuration,
        optimizationScore: 85.0,
        savings: { distance: 0, duration: 0, fuel: 0 }
      }
    });
  } catch (error) {
    console.error('❌ Optimize route error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// POST /api/routes/:id/start - Start route
app.post('/api/routes/:id/start', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `UPDATE routes SET status = 'IN_PROGRESS', started_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Route not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Start route error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// POST /api/routes/:id/complete - Complete route
app.post('/api/routes/:id/complete', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `UPDATE routes SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Route not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Complete route error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// ============================================
// 10. ORDER ROUTES
// ============================================

// GET /api/orders/my - Get orders for current seller
app.get('/api/orders/my', authenticateToken, async (req, res) => {
  try {
    const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (sellerResult.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Seller not found' });
    }
    const sellerId = sellerResult.rows[0].id;

    const { status, page = 1, limit = 20 } = req.query;
    let queryText = `SELECT * FROM orders WHERE seller_id = $1 AND deleted_at IS NULL`;
    const params = [sellerId];

    if (status) {
      params.push(status);
      queryText += ` AND status = $${params.length}`;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const result = await query(queryText, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Get my orders error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// POST /api/orders - Create order
app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (sellerResult.rows.length === 0) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Only sellers can create orders' });
    }
    const sellerId = sellerResult.rows[0].id;

    const { customerName, customerPhone, customerEmail, pickupAddress, deliveryAddress, pickupLat, pickupLng, deliveryLat, deliveryLng, items, totalWeight, totalVolume, totalValue, deliveryFee, discount, tax, paymentMethod, instructions, scheduledPickupAt, scheduledDeliveryAt } = req.body;

    if (!customerName || !customerPhone || !pickupAddress || !deliveryAddress || pickupLat === undefined || pickupLng === undefined || deliveryLat === undefined || deliveryLng === undefined) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Required fields missing' });
    }

    const totalAmount = (parseFloat(totalValue) || 0) + (parseFloat(deliveryFee) || 0) - (parseFloat(discount) || 0) + (parseFloat(tax) || 0);

    const result = await query(
      `INSERT INTO orders (seller_id, customer_name, customer_phone, customer_email, pickup_address, delivery_address, pickup_lat, pickup_lng, delivery_lat, delivery_lng, items, total_weight, total_volume, total_value, delivery_fee, discount, tax, total_amount, payment_method, instructions, scheduled_pickup_at, scheduled_delivery_at, status, payment_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'PENDING', 'PENDING', NOW(), NOW())
       RETURNING *`,
      [sellerId, customerName, customerPhone, customerEmail, JSON.stringify(pickupAddress), JSON.stringify(deliveryAddress), pickupLat, pickupLng, deliveryLat, deliveryLng, JSON.stringify(items || []), totalWeight, totalVolume, totalValue, deliveryFee || 0, discount || 0, tax || 0, totalAmount, paymentMethod || 'COD', instructions, scheduledPickupAt, scheduledDeliveryAt]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Create order error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// POST /api/orders/:id/assign - Assign order to driver/route
app.post('/api/orders/:id/assign', authenticateToken, async (req, res) => {
  try {
    const { driverId, routeId } = req.body;
    const orderId = req.params.id;

    const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
    if (sellerResult.rows.length === 0) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Not authorized' });
    }
    const sellerId = sellerResult.rows[0].id;

    const updates = ['updated_at = NOW()'];
    const params = [sellerId];
    let paramIndex = 2;

    if (driverId) {
      updates.push(`driver_id = $${paramIndex++}`);
      params.push(driverId);
    }
    if (routeId) {
      updates.push(`route_id = $${paramIndex++}`);
      params.push(routeId);
    }

    updates.push(`status = 'ASSIGNED'`);
    params.push(orderId);

    const queryText = `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramIndex} AND seller_id = $1 RETURNING *`;

    const result = await query(queryText, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Order not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Assign order error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// ============================================
// 11. TASK ROUTES
// ============================================

// GET /api/tasks/my - Get tasks for current driver
app.get('/api/tasks/my', authenticateToken, async (req, res) => {
  try {
    const driverResult = await query('SELECT id FROM drivers WHERE user_id = $1', [req.user.userId]);
    if (driverResult.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Driver not found' });
    }
    const driverId = driverResult.rows[0].id;

    const { status, page = 1, limit = 20 } = req.query;
    let queryText = `SELECT * FROM tasks WHERE driver_id = $1 AND deleted_at IS NULL`;
    const params = [driverId];

    if (status) {
      params.push(status);
      queryText += ` AND status = $${params.length}`;
    }

    queryText += ` ORDER BY sequence ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const result = await query(queryText, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Get my tasks error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// PATCH /api/tasks/:id/status - Update task status
app.patch('/api/tasks/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status, notes, proofOfDelivery } = req.body;
    const taskId = req.params.id;

    const driverResult = await query('SELECT id FROM drivers WHERE user_id = $1', [req.user.userId]);
    if (driverResult.rows.length === 0) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Not authorized' });
    }
    const driverId = driverResult.rows[0].id;

    const updates = ['updated_at = NOW()'];
    const params = [driverId];
    let paramIndex = 2;

    if (status) {
      updates.push(`status = $${paramIndex++}`);
      params.push(status);

      // Set timestamp based on status
      const now = new Date();
      if (status === 'PICKED_UP') updates.push(`actual_pickup_at = $${paramIndex++}`);
      else if (status === 'DELIVERED') updates.push(`actual_delivery_at = $${paramIndex++}`);
      params.push(now);
    }
    if (notes) {
      updates.push(`notes = $${paramIndex++}`);
      params.push(notes);
    }
    if (proofOfDelivery) {
      updates.push(`proof_of_delivery = $${paramIndex++}`);
      params.push(JSON.stringify(proofOfDelivery));
    }

    params.push(taskId);
    const queryText = `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramIndex} AND driver_id = $1 RETURNING *`;

    const result = await query(queryText, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Task not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Update task status error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// ============================================
// 12. NOTIFICATION ROUTES
// ============================================

/**
 * Map a raw notifications row to the camelCase shape the frontend
 * expects. The DB columns are snake_case (`user_id`, `body`,
 * `read_at`, `created_at`) but the frontend `Notification` type uses
 * camelCase (`userId`, `message`, `isRead`, `createdAt`).
 *
 * The DB has NO `is_read` column — only a `read_at` timestamp that
 * is null when unread. We derive `isRead` from that, since that's
 * the only signal the schema exposes. (A migration could add an
 * `is_read` boolean for faster filtering; for now the timestamp is
 * the source of truth.)
 *
 * Fields the frontend `Notification` type expects but that don't
 * exist in this DB schema (channel, priority, expiresAt, failedAt,
 * failureReason, sentAt) are filled with sensible defaults so the
 * type check passes and the bell renders correctly.
 */
function transformNotificationRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    channel: 'IN_APP',
    title: row.title,
    message: row.body,
    data: row.data ?? {},
    isRead: row.read_at !== null && row.read_at !== undefined,
    readAt: row.read_at,
    sentAt: null,
    failedAt: null,
    failureReason: null,
    priority: 0,
    expiresAt: null,
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

// GET /api/notifications - Get user notifications
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const { isRead, page = 1, limit = 20 } = req.query;
    let queryText = `SELECT * FROM notifications WHERE user_id = $1`;
    const params = [req.user.userId];

    // Filter by read state via the `read_at` timestamp (the DB has
    // no `is_read` boolean column). isRead=true → read_at IS NOT
    // NULL, isRead=false → read_at IS NULL.
    if (isRead !== undefined) {
      if (isRead === 'true') {
        queryText += ` AND read_at IS NOT NULL`;
      } else {
        queryText += ` AND read_at IS NULL`;
      }
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const result = await query(queryText, params);
    res.json({ success: true, data: result.rows.map(transformNotificationRow) });
  } catch (error) {
    console.error('❌ Get notifications error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// PATCH /api/notifications/:id/read - Mark notification as read
//
// Only the `read_at` column exists in the schema; we set it to NOW()
// (no-op if already set) and return the transformed row.
app.patch('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Notification not found' });
    }

    res.json({ success: true, data: transformNotificationRow(result.rows[0]) });
  } catch (error) {
    console.error('❌ Mark notification read error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// PATCH /api/notifications/read-all - Mark all of the caller's notifications as read
//
// Called by the bell's "Mark all read" button. Bulk update on the
// `read_at` column for everything the caller owns that hasn't been
// read yet. Returns the number of rows updated so the frontend can
// show a confirmation count if it wants.
app.patch('/api/notifications/read-all', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.userId]
    );
    res.json({ success: true, data: { updated: result.rowCount ?? 0 } });
  } catch (error) {
    console.error('❌ Mark all notifications read error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// ============================================
// 13. ANALYTICS ROUTES
// ============================================

// GET /api/analytics/dashboard - Dashboard metrics
app.get('/api/analytics/dashboard', authenticateToken, async (req, res) => {
  try {
    let metrics = {
      totalDeliveries: 0,
      activeDrivers: 0,
      totalRevenue: 0,
      avgDeliveryTime: 0,
      onTimeRate: 0,
      customerSatisfaction: 0,
      trend: { deliveries: 0, revenue: 0, drivers: 0 }
    };

    // Normalize role to uppercase for comparison (database stores lowercase)
    const userRole = (req.user.role || '').toUpperCase();

    if (userRole === 'SELLER') {
      const sellerResult = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.userId]);
      if (sellerResult.rows.length > 0) {
        const sellerId = sellerResult.rows[0].id;

        // Get order stats and active drivers count in parallel
        const [statsResult, driversResult] = await Promise.all([
          query(
            `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'DELIVERED') as completed, COALESCE(SUM(total_amount), 0) as revenue FROM orders WHERE seller_id = $1`,
            [sellerId]
          ),
          query(
            `SELECT COUNT(*) as active FROM drivers d JOIN sellers s ON d.seller_id = s.id WHERE s.id = $1 AND d.is_online = true`,
            [sellerId]
          )
        ]);

        const s = statsResult.rows[0];
        const d = driversResult.rows[0];

        metrics = {
          ...metrics,
          totalDeliveries: parseInt(s.total),
          completedDeliveries: parseInt(s.completed),
          totalRevenue: parseFloat(s.revenue),
          activeDrivers: parseInt(d.active)
        };
      }
    } else if (userRole === 'DRIVER') {
      const driverResult = await query('SELECT id FROM drivers WHERE user_id = $1', [req.user.userId]);
      if (driverResult.rows.length > 0) {
        const driverId = driverResult.rows[0].id;
        const statsResult = await query(
          `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'DELIVERED') as completed FROM tasks WHERE driver_id = $1`,
          [driverId]
        );
        const s = statsResult.rows[0];
        metrics = {
          ...metrics,
          totalDeliveries: parseInt(s.total),
          completedDeliveries: parseInt(s.completed)
        };
      }
    } else if (userRole === 'ADMIN') {
      const [ordersResult, driversResult, revenueResult] = await Promise.all([
        query('SELECT COUNT(*) as total FROM orders'),
        query('SELECT COUNT(*) as total FROM drivers WHERE is_online = true'),
        query('SELECT COALESCE(SUM(total_amount), 0) as revenue FROM orders WHERE payment_status = \'PAID\'')
      ]);
      metrics = {
        totalDeliveries: parseInt(ordersResult.rows[0].total),
        activeDrivers: parseInt(driversResult.rows[0].total),
        totalRevenue: parseFloat(revenueResult.rows[0].revenue)
      };
    }

    res.json({ success: true, data: metrics });
  } catch (error) {
    console.error('❌ Dashboard metrics error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// ============================================
// 14. SETTINGS ROUTES
// ============================================

// GET /api/settings - Get public settings
app.get('/api/settings', async (req, res) => {
  try {
    const result = await query(`SELECT key, value, description FROM settings WHERE is_public = true`);
    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('❌ Get settings error:', error.message);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

// ============================================
// 15. HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'RouteFlow API'
  });
});

// ============================================
// 16. START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║     RouteFlow Backend Server (Full API - Frontend Compatible)           ║
║     Running on http://localhost:${PORT}                                          ║
║                                                                          ║
║     Auth Endpoints:                                                     ║
║     POST   /api/auth/register     - Register new user                   ║
║     POST   /api/auth/login         - Login                              ║
║     POST   /api/auth/refresh       - Refresh access token               ║
║     POST   /api/auth/logout        - Logout                             ║
║                                                                          ║
║     User Endpoints:                                                     ║
║     GET    /api/users/me           - Get current user profile           ║
║                                                                          ║
║     Seller Endpoints:                                                   ║
║     GET    /api/sellers/me         - Get seller profile                 ║
║     POST   /api/sellers            - Create seller profile              ║
║     GET    /api/sellers/me/stats   - Get seller statistics              ║
║                                                                          ║
║     Driver Endpoints:                                                   ║
║     GET    /api/drivers/me         - Get driver profile                 ║
║     PATCH  /api/drivers/me/status  - Update online/available status     ║
║     POST   /api/drivers/me/location - Update driver location            ║
║     GET    /api/drivers/me/stats   - Get driver statistics              ║
║     GET    /api/drivers/available  - Get available drivers              ║
║                                                                          ║
║     Vehicle Endpoints:                                                  ║
║     GET    /api/vehicles/my        - Get seller's vehicles              ║
║     POST   /api/vehicles           - Create vehicle                     ║
║     PATCH  /api/vehicles/:id/assign-driver - Assign driver to vehicle   ║
║                                                                          ║
║     Route Endpoints:                                                    ║
║     GET    /api/routes/my          - Get seller's routes                ║
║     POST   /api/routes             - Create route                       ║
║     POST   /api/routes/optimize    - Optimize route                     ║
║     POST   /api/routes/:id/start   - Start route                        ║
║     POST   /api/routes/:id/complete - Complete route                    ║
║                                                                          ║
║     Order Endpoints:                                                    ║
║     GET    /api/orders/my          - Get seller's orders                ║
║     POST   /api/orders             - Create order                       ║
║     POST   /api/orders/:id/assign  - Assign order to driver/route       ║
║                                                                          ║
║     Task Endpoints:                                                     ║
║     GET    /api/tasks/my           - Get driver's tasks                 ║
║     PATCH  /api/tasks/:id/status   - Update task status                 ║
║                                                                          ║
║     Notification Endpoints:                                             ║
║     GET    /api/notifications      - Get user notifications             ║
║     PATCH  /api/notifications/:id/read - Mark notification read         ║
║     PATCH  /api/notifications/read-all - Mark all notifications read    ║
║                                                                          ║
║     Analytics Endpoints:                                                ║
║     GET    /api/analytics/dashboard - Dashboard metrics                 ║
║                                                                          ║
║     Settings Endpoints:                                                 ║
║     GET    /api/settings           - Get public settings                ║
║                                                                          ║
║     Other:                                                              ║
║     GET    /api/health             - Health check                       ║
╚════════════════════════════════════════════════════════════════════════════╝
  `);
});

// ============================================
// 7. DATABASE SETUP INSTRUCTIONS
// ============================================

/*
  BEFORE RUNNING THIS SERVER:

  1. Install dependencies:
     npm init -y
     npm install express pg bcrypt jsonwebtoken cors

  2. Create PostgreSQL database:
     CREATE DATABASE routeflow;

  3. Create users table (matches Prisma schema from frontend types):

     CREATE TABLE users (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       email VARCHAR(255) UNIQUE NOT NULL,
       password_hash VARCHAR(255) NOT NULL,
       first_name VARCHAR(100) NOT NULL,
       last_name VARCHAR(100) NOT NULL,
       phone VARCHAR(20),
       role VARCHAR(20) NOT NULL DEFAULT 'SELLER'
         CHECK (role IN ('ADMIN', 'SELLER', 'DRIVER')),
       status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
         CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION')),
       email_verified BOOLEAN NOT NULL DEFAULT FALSE,
       phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
       last_login_at TIMESTAMP,
       last_login_ip VARCHAR(45),
       failed_login_attempts INTEGER NOT NULL DEFAULT 0,
       locked_until TIMESTAMP,
       two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
       two_factor_secret VARCHAR(255),
       backup_codes TEXT[],
       refresh_token_hash VARCHAR(255),
       refresh_token_expires_at TIMESTAMP,
       avatar_url VARCHAR(500),
       created_at TIMESTAMP NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
       deleted_at TIMESTAMP
     );

     -- Create index for email lookups
     CREATE INDEX idx_users_email ON users(email);
     CREATE INDEX idx_users_refresh_token ON users(refresh_token_hash);

  4. Update database config in this file (pool configuration):
     - user: your postgres username
     - password: your postgres password
     - database: 'routeflow'

  5. Run the server:
     node server.js

  6. Frontend should connect to: http://localhost:3001/api

  TEST WITH CURL:

  # Register
  curl -X POST http://localhost:3001/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{
      "email": "john@example.com",
      "password": "securePassword123",
      "firstName": "John",
      "lastName": "Doe",
      "role": "SELLER"
    }'

  # Login
  curl -X POST http://localhost:3001/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email": "john@example.com", "password": "securePassword123"}'

  # Get profile (use accessToken from login)
  curl -X GET http://localhost:3001/api/users/me \
    -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

  # Refresh token (use refreshToken from login)
  curl -X POST http://localhost:3001/api/auth/refresh \
    -H "Content-Type: application/json" \
    -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
*/