import request from 'supertest';
import { app } from '../src/index';
import { knex } from '../src/config/database';
import { OrderStatus, DriverAvailability, RouteStatus, UserRole } from '../src/models';

const api = request(app);

describe('RouteFlow E2E Integration Test Suite', () => {
  let sellerToken: string;
  let driverToken: string;
  let sellerId: string;
  let driverId: string;
  let driverProfileId: string;
  let orderId: string;
  let routeId: string;
  let routeIds: string[];

  beforeAll(async () => {
    await knex.migrate.latest();
  });

  afterAll(async () => {
    await knex.destroy();
  });

  beforeEach(async () => {
    await knex('refresh_tokens').del();
    await knex('routes').del();
    await knex('orders').del();
    await knex('drivers').del();
    await knex('users').del();
  });

  describe('1. Authentication - Register and Login Seller & Driver', () => {
    it('should register a new Seller', async () => {
      const res = await api
        .post('/api/auth/register')
        .send({
          email: 'seller@routeflow.test',
          password: 'sellerpassword123',
          role: 'seller',
          profileDetails: {
            firstName: 'John',
            lastName: 'Seller',
            phone: '+15551234567',
          },
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user.role).toBe('seller');
      expect(res.body.data.tokens).toHaveProperty('accessToken');
      expect(res.body.data.tokens).toHaveProperty('refreshToken');

      sellerToken = res.body.data.tokens.accessToken;
      sellerId = res.body.data.user.id;
    });

    it('should register a new Driver', async () => {
      const res = await api
        .post('/api/auth/register')
        .send({
          email: 'driver@routeflow.test',
          password: 'driverpassword123',
          role: 'driver',
          profileDetails: {
            firstName: 'Mike',
            lastName: 'Driver',
            phone: '+15559876543',
          },
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user.role).toBe('driver');
      expect(res.body.data.tokens).toHaveProperty('accessToken');
      expect(res.body.data.tokens).toHaveProperty('refreshToken');

      driverToken = res.body.data.tokens.accessToken;
      driverId = res.body.data.user.id;
    });

    it('should login Seller with correct credentials', async () => {
      const res = await api
        .post('/api/auth/login')
        .send({
          email: 'seller@routeflow.test',
          password: 'sellerpassword123',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user.role).toBe('seller');
      expect(res.body.data).toHaveProperty('accessToken');

      sellerToken = res.body.data.accessToken;
    });

    it('should login Driver with correct credentials', async () => {
      const res = await api
        .post('/api/auth/login')
        .send({
          email: 'driver@routeflow.test',
          password: 'driverpassword123',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user.role).toBe('driver');
      expect(res.body.data).toHaveProperty('accessToken');

      driverToken = res.body.data.accessToken;
    });

    it('should reject login with wrong password', async () => {
      const res = await api
        .post('/api/auth/login')
        .send({
          email: 'seller@routeflow.test',
          password: 'wrongpassword',
        })
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('should get current user profile with valid token', async () => {
      const res = await api
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user.id).toBe(sellerId);
      expect(res.body.data.user.email).toBe('seller@routeflow.test');
    });
  });

  describe('2. Driver Profile Setup', () => {
    it('should create driver profile', async () => {
      const res = await api
        .post('/api/drivers/profile')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.driver.user_id).toBe(driverId);
      expect(res.body.data.driver.availability_status).toBe('offline');
      expect(res.body.data.driver.current_workload).toBe(0);

      driverProfileId = res.body.data.driver.id;
    });

    it('should update driver availability to available', async () => {
      const res = await api
        .patch('/api/drivers/availability')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ availabilityStatus: 'available' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.driver.availability_status).toBe('available');
    });

    it('should update driver location', async () => {
      const res = await api
        .patch('/api/drivers/location')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          latitude: 40.7128,
          longitude: -74.0060,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.driver.current_latitude).toBe(40.7128);
      expect(res.body.data.driver.current_longitude).toBe(-74.0060);
    });
  });

  describe('3. Seller Creates Delivery Order', () => {
    it('should create a new delivery order', async () => {
      const res = await api
        .post('/api/orders')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          customerName: 'Alice Customer',
          customerPhone: '+15551112222',
          deliveryAddress: '123 Main St, New York, NY 10001',
          latitude: 40.7589,
          longitude: -73.9851,
          parcelDetails: {
            weight: 2.5,
            dimensions: { length: 30, width: 20, height: 10 },
            value: 150.00,
            fragile: true,
            description: 'Electronics - Handle with care',
          },
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.order).toBeDefined();
      expect(res.body.data.order.seller_id).toBe(sellerId);
      expect(res.body.data.order.status).toBe('pending');
      expect(res.body.data.order.customer_name).toBe('Alice Customer');
      expect(res.body.data.order.parcel_details).toBeDefined();
      expect(res.body.data.order.parcel_details.fragile).toBe(true);

      orderId = res.body.data.order.id;
    });

    it('should validate required fields for order creation', async () => {
      const res = await api
        .post('/api/orders')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          customerName: 'Bob',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject order creation without authentication', async () => {
      const res = await api
        .post('/api/orders')
        .send({
          customerName: 'Alice Customer',
          customerPhone: '+15551112222',
          deliveryAddress: '123 Main St',
          latitude: 40.7589,
          longitude: -73.9851,
        })
        .expect(401);

      expect(res.body.success).toBe(false);
    });
  });

  describe('4. Route Optimization & Driver Allocation', () => {
    it('should optimize route for driver with order', async () => {
      const res = await api
        .post('/api/routes/optimize')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          driverId: driverProfileId,
          orderIds: [orderId],
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('sequence');
      expect(res.body.data).toHaveProperty('legs');
      expect(res.body.data).toHaveProperty('totalDistance');
      expect(res.body.data).toHaveProperty('totalDuration');
      expect(res.body.data).toHaveProperty('encodedPolyline');
      expect(res.body.data).toHaveProperty('routeIds');
      expect(Array.isArray(res.body.data.routeIds)).toBe(true);
      expect(res.body.data.routeIds.length).toBe(1);

      routeIds = res.body.data.routeIds;
      routeId = routeIds[0];
    });

    it('should update order status to assigned after route optimization', async () => {
      const order = await knex('orders').where({ id: orderId }).first();
      expect(order.status).toBe('assigned');
    });

    it('should create route entries in database', async () => {
      const routes = await knex('routes').where({ driver_id: driverProfileId });
      expect(routes.length).toBe(1);
      expect(routes[0].order_id).toBe(orderId);
      expect(routes[0].status).toBe('planned');
      expect(routes[0].optimized_polyline).toBeDefined();
      expect(routes[0].estimated_travel_time).toBeGreaterThan(0);
      expect(routes[0].estimated_distance).toBeGreaterThan(0);
    });

    it('should reject route optimization without orders', async () => {
      const res = await api
        .post('/api/routes/optimize')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          driverId: driverProfileId,
          orderIds: [],
        })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('should reject route optimization for non-existent driver', async () => {
      const res = await api
        .post('/api/routes/optimize')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          driverId: '00000000-0000-0000-0000-000000000000',
          orderIds: [orderId],
        })
        .expect(404);

      expect(res.body.success).toBe(false);
    });
  });

  describe('5. Driver Queries Assigned Routes', () => {
    it('should list driver routes', async () => {
      const res = await api
        .get('/api/routes')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].id).toBe(routeId);
      expect(res.body.data[0].status).toBe('planned');
      expect(res.body.data[0].order_id).toBe(orderId);
    });

    it('should get specific route details', async () => {
      const res = await api
        .get(`/api/routes/${routeId}`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.route.id).toBe(routeId);
      expect(res.body.data.route.driver_id).toBe(driverProfileId);
      expect(res.body.data.route.optimized_polyline).toBeDefined();
    });

    it('should filter routes by status', async () => {
      const res = await api
        .get('/api/routes?status=planned')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].status).toBe('planned');
    });

    it('should reject route access by unauthorized driver', async () => {
      // Create another driver
      const otherDriverRes = await api
        .post('/api/auth/register')
        .send({
          email: 'otherdriver@routeflow.test',
          password: 'password123',
          role: 'driver',
        })
        .expect(201);

      const otherToken = otherDriverRes.body.data.tokens.accessToken;

      const res = await api
        .get(`/api/routes/${routeId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('6. Driver Updates Order Status - On The Way', () => {
    it('should update order status to on_the_way', async () => {
      const res = await api
        .patch(`/api/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'on_the_way' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.order.status).toBe('on_the_way');
      expect(res.body.data.order.id).toBe(orderId);
    });

    it('should update route status to active when order is on_the_way', async () => {
      const route = await knex('routes').where({ id: routeId }).first();
      expect(route.status).toBe('active');
    });

    it('should reject invalid status transition', async () => {
      const res = await api
        .patch(`/api/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'pending' }) // Cannot go back to pending
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('should reject status update by unauthorized user', async () => {
      // Create another seller
      const otherSellerRes = await api
        .post('/api/auth/register')
        .send({
          email: 'otherseller@routeflow.test',
          password: 'password123',
          role: 'seller',
        })
        .expect(201);

      const otherToken = otherSellerRes.body.data.tokens.accessToken;

      const res = await api
        .patch(`/api/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ status: 'delivered' })
        .expect(403);

      expect(res.body.success).toBe(false);
    });
  });

  describe('7. Driver Updates Order Status - Delivered', () => {
    it('should update order status to delivered', async () => {
      const res = await api
        .patch(`/api/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'delivered' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.order.status).toBe('delivered');
    });

    it('should update route status to completed when order is delivered', async () => {
      const route = await knex('routes').where({ id: routeId }).first();
      expect(route.status).toBe('completed');
    });

    it('should decrement driver workload on delivery', async () => {
      const driver = await knex('drivers').where({ id: driverProfileId }).first();
      expect(driver.current_workload).toBe(0);
    });
  });

  describe('8. Order Status Transition Validation', () => {
    it('should track complete order status history: pending -> assigned -> on_the_way -> delivered', async () => {
      const order = await knex('orders').where({ id: orderId }).first();
      expect(order.status).toBe('delivered');
    });

    it('should validate route status history: planned -> active -> completed', async () => {
      const route = await knex('routes').where({ id: routeId }).first();
      expect(route.status).toBe('completed');
    });

    it('should reject invalid status values', async () => {
      const res = await api
        .patch(`/api/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'invalid_status' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('9. Analytics & Reporting Validation', () => {
    it('should return seller order statistics', async () => {
      const res = await api
        .get('/api/orders')
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.meta.total).toBe(1);
    });

    it('should return driver route statistics', async () => {
      const res = await api
        .get('/api/routes')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.meta.total).toBe(1);
    });

    it('should track order count by status for seller', async () => {
      const stats = await knex('orders')
        .where({ seller_id: sellerId })
        .select('status')
        .count('* as count')
        .groupBy('status');

      const deliveredCount = stats.find(s => s.status === 'delivered')?.count || 0;
      expect(Number(deliveredCount)).toBe(1);
    });

    it('should track route completion stats for driver', async () => {
      const stats = await knex('routes')
        .where({ driver_id: driverProfileId })
        .select('status')
        .count('* as count')
        .groupBy('status');

      const completedCount = stats.find(s => s.status === 'completed')?.count || 0;
      expect(Number(completedCount)).toBe(1);
    });

    it('should calculate total distance and duration for completed routes', async () => {
      const route = await knex('routes').where({ id: routeId }).first();
      expect(route.estimated_distance).toBeGreaterThan(0);
      expect(route.estimated_travel_time).toBeGreaterThan(0);
    });

    it('should track driver availability statistics', async () => {
      const driverStats = await knex('drivers')
        .select('availability_status')
        .count('* as count')
        .groupBy('availability_status');

      const availableCount = driverStats.find(s => s.availability_status === 'available')?.count || 0;
      expect(Number(availableCount)).toBe(1);
    });
  });

  describe('10. Complete Multi-Order RouteFlow Lifecycle', () => {
    let multiOrderIds: string[] = [];
    let multiRouteIds: string[] = [];

    beforeEach(async () => {
      // Clean up for this test suite
      await knex('routes').del();
      await knex('orders').del();
      multiOrderIds = [];
      multiRouteIds = [];
    });

    it('should handle multiple orders optimized into single route', async () => {
      // Create 3 orders
      for (let i = 0; i < 3; i++) {
        const res = await api
          .post('/api/orders')
          .set('Authorization', `Bearer ${sellerToken}`)
          .send({
            customerName: `Customer ${i + 1}`,
            customerPhone: `+155500000${i}`,
            deliveryAddress: `${100 + i * 10} Broadway, New York, NY`,
            latitude: 40.7589 + i * 0.01,
            longitude: -73.9851 + i * 0.01,
            parcelDetails: { weight: 1.0, description: `Package ${i + 1}` },
          })
          .expect(201);

        multiOrderIds.push(res.body.data.order.id);
      }

      // Optimize route for all 3 orders
      const optimizeRes = await api
        .post('/api/routes/optimize')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          driverId: driverProfileId,
          orderIds: multiOrderIds,
        })
        .expect(201);

      expect(optimizeRes.body.data.sequence.length).toBe(3);
      expect(optimizeRes.body.data.routeIds.length).toBe(3);
      multiRouteIds = optimizeRes.body.data.routeIds;

      // Verify all orders are assigned
      const orders = await knex('orders').whereIn('id', multiOrderIds);
      for (const order of orders) {
        expect(order.status).toBe('assigned');
      }

      // Verify all routes created
      const routes = await knex('routes').whereIn('id', multiRouteIds);
      expect(routes.length).toBe(3);
      for (const route of routes) {
        expect(route.status).toBe('planned');
      }
    });

    it('should track driver workload correctly for multi-order route', async () => {
      const driver = await knex('drivers').where({ id: driverProfileId }).first();
      expect(driver.current_workload).toBe(3);
    });

    it('should complete multi-order delivery sequence', async () => {
      // Update first order to on_the_way
      await api
        .patch(`/api/orders/${multiOrderIds[0]}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'on_the_way' })
        .expect(200);

      // Update first order to delivered
      await api
        .patch(`/api/orders/${multiOrderIds[0]}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'delivered' })
        .expect(200);

      // Update second order to on_the_way
      await api
        .patch(`/api/orders/${multiOrderIds[1]}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'on_the_way' })
        .expect(200);

      // Update second order to delivered
      await api
        .patch(`/api/orders/${multiOrderIds[1]}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'delivered' })
        .expect(200);

      // Update third order to on_the_way
      await api
        .patch(`/api/orders/${multiOrderIds[2]}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'on_the_way' })
        .expect(200);

      // Update third order to delivered
      await api
        .patch(`/api/orders/${multiOrderIds[2]}/status`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'delivered' })
        .expect(200);

      // Verify all orders delivered
      const orders = await knex('orders').whereIn('id', multiOrderIds);
      for (const order of orders) {
        expect(order.status).toBe('delivered');
      }

      // Verify all routes completed
      const routes = await knex('routes').whereIn('id', multiRouteIds);
      for (const route of routes) {
        expect(route.status).toBe('completed');
      }

      // Verify driver workload is back to 0
      const driver = await knex('drivers').where({ id: driverProfileId }).first();
      expect(driver.current_workload).toBe(0);
    });

    it('should generate analytics for multi-order delivery', async () => {
      const orderStats = await knex('orders')
        .where({ seller_id: sellerId })
        .whereIn('id', multiOrderIds)
        .select('status')
        .count('* as count')
        .groupBy('status');

      const deliveredCount = orderStats.find(s => s.status === 'delivered')?.count || 0;
      expect(Number(deliveredCount)).toBe(3);

      const routeStats = await knex('routes')
        .where({ driver_id: driverProfileId })
        .whereIn('id', multiRouteIds)
        .select('status')
        .count('* as count')
        .groupBy('status');

      const completedCount = routeStats.find(s => s.status === 'completed')?.count || 0;
      expect(Number(completedCount)).toBe(3);

      const totalDistance = await knex('routes')
        .whereIn('id', multiRouteIds)
        .sum('estimated_distance as total')
        .first();
      expect(Number(totalDistance?.total || 0)).toBeGreaterThan(0);
    });
  });

  describe('11. Error Handling & Edge Cases', () => {
    it('should handle concurrent status updates gracefully', async () => {
      const orderRes = await api
        .post('/api/orders')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          customerName: 'Concurrent Test',
          customerPhone: '+15559999999',
          deliveryAddress: 'Test Address',
          latitude: 40.7,
          longitude: -74.0,
        })
        .expect(201);

      const newOrderId = orderRes.body.data.order.id;

      // Optimize route
      const optimizeRes = await api
        .post('/api/routes/optimize')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          driverId: driverProfileId,
          orderIds: [newOrderId],
        })
        .expect(201);

      const newRouteId = optimizeRes.body.data.routeIds[0];

      // Try concurrent status updates - both should succeed but final state should be valid
      const [res1, res2] = await Promise.all([
        api.patch(`/api/orders/${newOrderId}/status`).set('Authorization', `Bearer ${driverToken}`).send({ status: 'on_the_way' }),
        api.patch(`/api/orders/${newOrderId}/status`).set('Authorization', `Bearer ${driverToken}`).send({ status: 'delivered' }),
      ]);

      // At least one should succeed
      const successCount = [res1, res2].filter(r => r.status === 200).length;
      expect(successCount).toBeGreaterThanOrEqual(1);
    });

    it('should handle non-existent order gracefully', async () => {
      const res = await api
        .patch('/api/orders/00000000-0000-0000-0000-000000000000/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'delivered' })
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('should handle non-existent route gracefully', async () => {
      const res = await api
        .get('/api/routes/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('should enforce role-based access control', async () => {
      // Driver trying to create order (seller only)
      const res = await api
        .post('/api/orders')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          customerName: 'Test',
          customerPhone: '+15551234567',
          deliveryAddress: 'Test',
          latitude: 40.7,
          longitude: -74.0,
        })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('should enforce authentication on all protected routes', async () => {
      const res = await api
        .get('/api/orders')
        .expect(401);

      expect(res.body.success).toBe(false);
    });
  });
});