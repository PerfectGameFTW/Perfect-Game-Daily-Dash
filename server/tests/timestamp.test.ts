import { describe, it, expect, beforeAll } from 'vitest';
import { pgStorage } from '../pgStorage';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { EASTERN_TIMEZONE, toUTCStorage, getUTCDateRange, formatInEasternTime } from '../dateUtils';

describe('Timestamp Handling', () => {
  // Sample test data
  const testOrder = {
    squareId: 'TEST_TIMESTAMP_ORDER',
    status: 'COMPLETED',
    totalMoney: 100,
    totalTax: 8,
    totalDiscount: 0,
    createdAt: new Date('2025-02-28T12:00:00Z'), // Noon UTC
    source: 'TEST',
    squareData: {}
  };

  describe('UTC Storage', () => {
    it('should store timestamps in UTC', async () => {
      const savedOrder = await pgStorage.createOrder(testOrder);

      // Query the raw timestamp from the database
      const result = await db.execute(sql`
        SELECT created_at
        FROM orders
        WHERE id = ${savedOrder.id}
      `);

      const storedTimestamp = result.rows[0].created_at;
      expect(storedTimestamp.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    });
  });

  describe('Eastern Time Views', () => {
    it('should convert timestamps to Eastern Time in views', async () => {
      const savedOrder = await pgStorage.createOrder(testOrder);

      // Query both UTC and ET timestamps
      const result = await db.execute(sql`
        SELECT 
          o.created_at as utc_timestamp,
          oe.created_at_et as et_timestamp
        FROM orders o
        JOIN orders_et oe ON o.id = oe.id
        WHERE o.id = ${savedOrder.id}
      `);

      const { utc_timestamp, et_timestamp } = result.rows[0];

      // UTC should be noon
      expect(utc_timestamp.getUTCHours()).toBe(12);

      // ET should be 7am (5 hours behind UTC)
      expect(et_timestamp.getHours()).toBe(7);
    });
  });

  describe('Date Range Queries', () => {
    it('should handle date ranges correctly in Eastern Time', async () => {
      // Create orders at different times
      const orders = [
        { ...testOrder, squareId: 'TS_1', createdAt: new Date('2025-02-28T04:59:00Z') }, // 11:59pm ET previous day
        { ...testOrder, squareId: 'TS_2', createdAt: new Date('2025-02-28T05:01:00Z') }, // 12:01am ET
        { ...testOrder, squareId: 'TS_3', createdAt: new Date('2025-03-01T04:59:00Z') }, // 11:59pm ET
        { ...testOrder, squareId: 'TS_4', createdAt: new Date('2025-03-01T05:01:00Z') }  // 12:01am ET next day
      ];

      for (const order of orders) {
        await pgStorage.createOrder(order);
      }

      // Query orders for Feb 28 Eastern Time
      const result = await db.execute(sql`
        SELECT COUNT(*)
        FROM orders_et
        WHERE DATE(created_at_et) = '2025-02-28'
      `);

      // Should only include orders between midnight and 11:59pm ET on Feb 28
      expect(Number(result.rows[0].count)).toBe(2);
    });
  });

  describe('DateUtils Functions', () => {
    it('should convert dates to UTC for storage', () => {
      const eastern = new Date('2025-02-28T07:00:00-05:00'); // 7am ET
      const utc = toUTCStorage(eastern);
      expect(utc.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    });

    it('should handle date ranges with timezone boundaries', () => {
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
  });
});