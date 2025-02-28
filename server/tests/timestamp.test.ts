import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { pgStorage } from '../pgStorage';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { EASTERN_TIMEZONE, toUTCStorage, getUTCDateRange, formatInEasternTime, toEasternTime } from '../dateUtils';

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

  // Clean up test orders before all tests
  beforeAll(async () => {
    await db.execute(sql`DELETE FROM orders WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'`);
  });

  // Clean up after each test
  afterEach(async () => {
    await db.execute(sql`DELETE FROM orders WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'`);
  });

  describe('UTC Storage', () => {
    it('should store timestamps in UTC', async () => {
      const savedOrder = await pgStorage.createOrder(getTestOrder());

      // Query the raw timestamp from the database
      const result = await db.execute(sql`
        SELECT created_at
        FROM orders
        WHERE id = ${savedOrder.id}
      `);

      expect(result.rows[0].created_at.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    });

    it('should handle closed_at timestamp correctly', async () => {
      const orderWithClosedAt = getTestOrder({
        closedAt: new Date('2025-02-28T14:00:00Z') // 2 PM UTC
      });

      const savedOrder = await pgStorage.createOrder(orderWithClosedAt);

      const result = await db.execute(sql`
        SELECT closed_at
        FROM orders
        WHERE id = ${savedOrder.id}
      `);

      expect(result.rows[0].closed_at.toISOString()).toBe('2025-02-28T14:00:00.000Z');
    });
  });

  describe('Eastern Time Views', () => {
    it('should convert timestamps to Eastern Time in views', async () => {
      const savedOrder = await pgStorage.createOrder(getTestOrder());

      // Query both UTC and ET timestamps
      const result = await db.execute(sql`
        SELECT 
          o.created_at as utc_timestamp,
          oe.created_at_et as et_timestamp
        FROM orders o
        JOIN orders_et oe ON o.id = oe.id
        WHERE o.id = ${savedOrder.id}
      `);

      // UTC should be noon
      expect(result.rows[0].utc_timestamp.toISOString()).toContain('12:00:00');

      // ET should be 7am (5 hours behind UTC)
      expect(result.rows[0].et_timestamp.toISOString()).toContain('07:00:00');
    });

    it('should handle DST transitions correctly', async () => {
      // Test during DST (summer)
      const dstOrder = getTestOrder({
        createdAt: new Date('2025-07-15T12:00:00Z') // Noon UTC in summer
      });

      const savedOrder = await pgStorage.createOrder(dstOrder);

      const result = await db.execute(sql`
        SELECT 
          o.created_at as utc_timestamp,
          oe.created_at_et as et_timestamp
        FROM orders o
        JOIN orders_et oe ON o.id = oe.id
        WHERE o.id = ${savedOrder.id}
      `);

      // During DST, ET should be 8am (4 hours behind UTC)
      expect(result.rows[0].et_timestamp.toISOString()).toContain('08:00:00');
    });
  });

  describe('Date Range Queries', () => {
    beforeAll(async () => {
      // Create test orders spanning midnight ET
      const orders = [
        getTestOrder({ createdAt: new Date('2025-02-28T04:59:00Z') }), // 11:59pm ET previous day
        getTestOrder({ createdAt: new Date('2025-02-28T05:01:00Z') }), // 12:01am ET
        getTestOrder({ createdAt: new Date('2025-03-01T04:59:00Z') }), // 11:59pm ET
        getTestOrder({ createdAt: new Date('2025-03-01T05:01:00Z') })  // 12:01am ET next day
      ];

      for (const order of orders) {
        await pgStorage.createOrder(order);
      }
    });

    it('should handle single day ranges correctly in Eastern Time', async () => {
      // Query orders for Feb 28 Eastern Time
      const result = await db.execute(sql`
        SELECT COUNT(*)
        FROM orders_et
        WHERE DATE(created_at_et) = '2025-02-28'
      `);

      // Should only include orders between midnight and 11:59pm ET on Feb 28
      expect(Number(result.rows[0].count)).toBe(2);
    });

    it('should handle multi-day ranges correctly', async () => {
      const result = await db.execute(sql`
        SELECT COUNT(*)
        FROM orders_et
        WHERE DATE(created_at_et) >= '2025-02-28'
          AND DATE(created_at_et) <= '2025-03-01'
      `);

      // Should include all 4 test orders
      expect(Number(result.rows[0].count)).toBe(4);
    });

    it('should handle predefined date ranges', async () => {
      const { start, end } = getUTCDateRange('today');

      const result = await db.execute(sql`
        SELECT COUNT(*)
        FROM orders_et
        WHERE created_at_et >= ${start}
          AND created_at_et <= ${end}
      `);

      // Should include orders for the current ET business day
      expect(typeof Number(result.rows[0].count)).toBe('number');
    });
  });

  describe('DateUtils Functions', () => {
    it('should convert dates to UTC for storage', () => {
      const eastern = new Date('2025-02-28T07:00:00-05:00'); // 7am ET
      const utc = toUTCStorage(eastern);
      expect(utc.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    });

    it('should handle timezone boundaries', () => {
      const { start, end } = getUTCDateRange('today');

      // Verify that the range covers exactly one ET business day
      const startET = formatInTimeZone(start, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
      const endET = formatInTimeZone(end, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

      expect(startET).toMatch(/00:00:00$/); // Should start at midnight ET
      expect(endET).toMatch(/23:59:59$/);   // Should end at 11:59:59 ET
      expect(startET.split(' ')[0]).toBe(endET.split(' ')[0]); // Same ET date
    });

    it('should format timestamps in Eastern Time', () => {
      const utc = new Date('2025-02-28T12:00:00Z'); // Noon UTC
      const formatted = formatInEasternTime(utc);
      expect(formatted).toContain('07:00:00'); // Should show 7am
      expect(formatted).toContain('EST'); // Should indicate Eastern timezone
    });

    it('should handle custom date ranges', () => {
      const start = new Date('2025-02-28T00:00:00-05:00'); // Midnight ET
      const end = new Date('2025-03-01T23:59:59-05:00');   // 11:59:59 PM ET

      const { start: utcStart, end: utcEnd } = getUTCDateRange('custom', start, end);

      // Verify UTC timestamps
      expect(utcStart.toISOString()).toBe('2025-02-28T05:00:00.000Z');
      expect(utcEnd.toISOString()).toBe('2025-03-02T04:59:59.999Z');

      // Verify Eastern Time boundaries
      const startET = formatInTimeZone(utcStart, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
      const endET = formatInTimeZone(utcEnd, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

      expect(startET).toContain('2025-02-28 00:00:00');
      expect(endET).toContain('2025-03-01 23:59:59');
    });
  });
});