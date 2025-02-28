import { describe, it, expect, beforeEach } from 'vitest';
import { pgStorage } from '../pgStorage';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { EASTERN_TIMEZONE, toUTCStorage, getUTCDateRange, formatInEasternTime } from '../dateUtils';

describe('Timestamp Handling', () => {
  // Generate unique ID for each test
  const getUniqueTestId = () => `TEST_TIMESTAMP_ORDER_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  // Sample test data
  const getTestOrder = (overrides = {}) => ({
    squareId: getUniqueTestId(),
    status: 'COMPLETED',
    totalMoney: 100,
    totalTax: 8,
    totalDiscount: 0,
    createdAt: new Date('2025-02-28T12:00:00Z'), // Noon UTC
    source: 'TEST',
    squareData: {},
    ...overrides
  });

  // Clean up test orders before each test
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM orders WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'`);
  });

  describe('DateUtils Functions', () => {
    it('should convert dates to UTC for storage', () => {
      const eastern = new Date('2025-02-28T07:00:00-05:00'); // 7am ET
      const utc = toUTCStorage(eastern);
      expect(utc.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    });

    it('should format timestamps in Eastern Time', () => {
      const utc = new Date('2025-02-28T12:00:00Z'); // Noon UTC
      const formatted = formatInEasternTime(utc);
      expect(formatted).toContain('07:00:00'); // Should show 7am
      expect(formatted).toContain('EST'); // Should indicate Eastern timezone
    });

    it('should handle timezone boundaries', () => {
      const { start, end } = getUTCDateRange('today');
      const startET = formatInTimeZone(start, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
      const endET = formatInTimeZone(end, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

      expect(startET).toMatch(/00:00:00$/); // Should start at midnight ET
      expect(endET).toMatch(/23:59:59$/);   // Should end at 11:59:59 ET
      expect(startET.split(' ')[0]).toBe(endET.split(' ')[0]); // Same ET date
    });
  });

  describe('UTC Storage', () => {
    it('should store timestamps in UTC', async () => {
      const savedOrder = await pgStorage.createOrder(getTestOrder());
      const result = await db.execute(sql`
        SELECT created_at AT TIME ZONE 'UTC' as created_at_utc
        FROM orders
        WHERE id = ${savedOrder.id}
      `);

      const timestamp = new Date(result.rows[0].created_at_utc);
      expect(timestamp.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    });

    it('should handle closed_at timestamp correctly', async () => {
      const orderWithClosedAt = getTestOrder({
        closedAt: new Date('2025-02-28T14:00:00Z') // 2 PM UTC
      });

      const savedOrder = await pgStorage.createOrder(orderWithClosedAt);
      const result = await db.execute(sql`
        SELECT closed_at AT TIME ZONE 'UTC' as closed_at_utc
        FROM orders
        WHERE id = ${savedOrder.id}
      `);

      const timestamp = new Date(result.rows[0].closed_at_utc);
      expect(timestamp.toISOString()).toBe('2025-02-28T14:00:00.000Z');
    });
  });

  describe('Date Range Queries', () => {
    beforeEach(async () => {
      // First clean up any existing test data
      await db.execute(sql`DELETE FROM orders WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'`);

      // Create test orders spanning midnight ET
      const orders = [
        // Feb 27 in ET (11:59 PM ET = Feb 28 04:59 UTC)
        getTestOrder({ createdAt: new Date('2025-02-28T04:59:00Z') }), 

        // Feb 28 in ET
        getTestOrder({ createdAt: new Date('2025-02-28T05:01:00Z') }), // 12:01 AM ET
        getTestOrder({ createdAt: new Date('2025-02-28T16:00:00Z') }), // 11:00 AM ET
        getTestOrder({ createdAt: new Date('2025-03-01T04:59:00Z') }), // 11:59 PM ET

        // Mar 1 in ET (12:01 AM ET = Mar 1 05:01 UTC)
        getTestOrder({ createdAt: new Date('2025-03-01T05:01:00Z') })
      ];

      for (const order of orders) {
        const saved = await pgStorage.createOrder(order);
        console.log(`Created test order ${saved.id}:`, {
          utc: order.createdAt.toISOString(),
          et: formatInTimeZone(order.createdAt, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
        });
      }
    });

    it('should handle single day ranges correctly in Eastern Time', async () => {
      // Query orders for Feb 28 Eastern Time
      const result = await db.execute(sql`
        WITH orders_in_et AS (
          SELECT *, created_at AT TIME ZONE 'America/New_York' as created_at_et
          FROM orders
          WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'
        )
        SELECT COUNT(*)
        FROM orders_in_et
        WHERE DATE(created_at_et) = '2025-02-28'::date
      `);

      // Log current count
      console.log('Single day query count:', result.rows[0].count);

      // Should include orders between midnight and 11:59pm ET on Feb 28 (3 orders)
      expect(Number(result.rows[0].count)).toBe(3);
    });

    it('should handle multi-day ranges correctly', async () => {
      // Query orders for Feb 28 and Mar 1 Eastern Time
      const result = await db.execute(sql`
        WITH orders_in_et AS (
          SELECT *, created_at AT TIME ZONE 'America/New_York' as created_at_et
          FROM orders
          WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'
        )
        SELECT COUNT(*)
        FROM orders_in_et
        WHERE DATE(created_at_et) >= '2025-02-28'::date
          AND DATE(created_at_et) <= '2025-03-01'::date
      `);

      // Log current count
      console.log('Multi-day query count:', result.rows[0].count);

      // Should include all orders from midnight Feb 28 to 11:59pm Mar 1 (4 orders)
      expect(Number(result.rows[0].count)).toBe(4);
    });
  });
});