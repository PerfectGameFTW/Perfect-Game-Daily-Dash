import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { pgStorage } from '../pgStorage';
import { convertSquareOrderToOrder } from '../squareClient';
import { db } from '../db';
import { orders } from '@shared/schema';
import { InvalidOrderDataError, OrderNotFoundError } from '../errors';

describe('Order Operations', () => {
  const testOrder = {
    squareId: 'TEST_ORDER_123',
    status: 'COMPLETED',
    totalMoney: 100.50,
    totalTax: 8.50,
    totalDiscount: 10.00,
    createdAt: new Date(),
    source: 'POS',
    squareData: { test: 'data' }
  };

  const testLineItem = {
    name: 'Test Item',
    quantity: 2,
    basePriceMoney: 45.00,
    totalMoney: 90.00,
    squareData: { test: 'item data' }
  };

  let orderId: number;

  afterEach(async () => {
    await db.delete(orders).where(eq(orders.squareId, 'TEST_ORDER_123'));
  });

  describe('Order Creation', () => {
    it('should create an order with valid data', async () => {
      const order = await pgStorage.createOrder(testOrder);
      expect(order).toBeDefined();
      expect(order.squareId).toBe(testOrder.squareId);
      orderId = order.id;
    });

    it('should throw InvalidOrderDataError when required fields are missing', async () => {
      const invalidOrder = { ...testOrder, squareId: undefined } as any;
      await expect(pgStorage.createOrder(invalidOrder)).rejects.toThrow(InvalidOrderDataError);
    });
  });

  describe('Order Retrieval', () => {
    beforeEach(async () => {
      const order = await pgStorage.createOrder(testOrder);
      orderId = order.id;
    });

    it('should retrieve an order by ID', async () => {
      const order = await pgStorage.getOrder(orderId);
      expect(order).toBeDefined();
      expect(order?.squareId).toBe(testOrder.squareId);
    });

    it('should retrieve an order by Square ID', async () => {
      const order = await pgStorage.getOrderBySquareId(testOrder.squareId);
      expect(order).toBeDefined();
      expect(order?.id).toBe(orderId);
    });

    it('should throw OrderNotFoundError for non-existent order', async () => {
      await expect(pgStorage.getOrder(99999999)).rejects.toThrow(OrderNotFoundError);
    });
  });

  describe('Line Items', () => {
    beforeEach(async () => {
      const order = await pgStorage.createOrder(testOrder);
      orderId = order.id;
    });

    it('should create and retrieve line items', async () => {
      const lineItem = await pgStorage.createOrderItem({
        ...testLineItem,
        orderId
      });
      expect(lineItem).toBeDefined();
      expect(lineItem.name).toBe(testLineItem.name);

      const items = await pgStorage.getOrderItems(orderId);
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe(testLineItem.name);
    });
  });

  describe('Order Summary', () => {
    it('should generate correct summary for date range', async () => {
      await pgStorage.createOrder(testOrder);

      const summary = await pgStorage.getOrderSummary('today');
      expect(summary).toBeDefined();
      expect(typeof summary.totalOrders).toBe('number');
      expect(typeof summary.totalRevenue).toBe('number');
    });
  });

  describe('Square Integration', () => {
    it('should convert Square order to internal format', () => {
      const squareOrder = {
        id: 'SQUARE_ORDER_123',
        state: 'COMPLETED',
        totalMoney: { amount: 10050, currency: 'USD' },
        createdAt: new Date().toISOString()
      };

      const converted = convertSquareOrderToOrder(squareOrder);
      expect(converted).toBeDefined();
      expect(converted.squareId).toBe(squareOrder.id);
      expect(converted.totalMoney).toBe(100.50);
    });
  });
});
