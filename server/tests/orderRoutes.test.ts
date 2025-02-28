import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerRoutes } from '../routes';
import { pgStorage } from '../pgStorage';

describe('Order API Routes', () => {
  let app: express.Express;
  let server: any;

  beforeAll(async () => {
    app = express();
    server = await registerRoutes(app);
  });

  describe('GET /api/orders', () => {
    it('should return orders for valid date range', async () => {
      const response = await request(app)
        .get('/api/orders')
        .query({ dateRange: 'today' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should handle invalid date range', async () => {
      const response = await request(app)
        .get('/api/orders')
        .query({ dateRange: 'invalid' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('GET /api/order-summary', () => {
    it('should return valid summary data', async () => {
      const response = await request(app)
        .get('/api/order-summary')
        .query({ dateRange: 'today' });

      expect(response.status).toBe(200);
      expect(response.body.totalOrders).toBeDefined();
      expect(response.body.totalRevenue).toBeDefined();
    });
  });

  describe('GET /api/orders/:orderId', () => {
    it('should return order details with related data', async () => {
      // Create a test order first
      const testOrder = await pgStorage.createOrder({
        squareId: 'TEST_API_ORDER',
        status: 'COMPLETED',
        totalMoney: 100,
        totalTax: 8,
        totalDiscount: 0,
        createdAt: new Date(),
        source: 'TEST',
        squareData: {}
      });

      const response = await request(app)
        .get(`/api/orders/${testOrder.id}`);

      expect(response.status).toBe(200);
      expect(response.body.order).toBeDefined();
      expect(response.body.lineItems).toBeDefined();
      expect(response.body.discounts).toBeDefined();
    });

    it('should return 404 for non-existent order', async () => {
      const response = await request(app)
        .get('/api/orders/99999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('POST /api/sync/orders', () => {
    it('should initiate order sync', async () => {
      const response = await request(app)
        .post('/api/sync/orders')
        .send({
          startDate: new Date().toISOString(),
          endDate: new Date().toISOString()
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle invalid date format', async () => {
      const response = await request(app)
        .post('/api/sync/orders')
        .send({
          startDate: 'invalid-date'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });
  });
});
