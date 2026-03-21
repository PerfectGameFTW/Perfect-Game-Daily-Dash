import { describe, it, expect, beforeEach } from 'vitest';
import { pgStorage } from '../pgStorage';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { EASTERN_TIMEZONE, getEasternDateRange } from '../dateUtils';

describe('Timestamp Handling', () => {
  const getUniqueTestId = () => `TEST_TIMESTAMP_ORDER_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const getTestOrder = (overrides = {}) => ({
    squareId: getUniqueTestId(),
    status: 'COMPLETED',
    totalMoney: 100,
    totalTax: 8,
    totalDiscount: 0,
    createdAt: new Date('2025-02-28T12:00:00Z'),
    source: 'TEST',
    squareData: {},
    ...overrides
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM orders WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'`);
  });

  describe('DateUtils Functions', () => {
    it('should correctly convert ET wall-clock time to UTC', () => {
      // 7am Eastern Standard Time (UTC-5) = noon UTC
      const utc = fromZonedTime('2025-02-28T07:00:00', EASTERN_TIMEZONE);
      expect(utc.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    });

    it('should format UTC timestamps correctly in Eastern Time', () => {
      const utc = new Date('2025-02-28T12:00:00Z'); // Noon UTC = 7am EST
      const formatted = formatInTimeZone(utc, EASTERN_TIMEZONE, 'HH:mm:ss zzz');
      expect(formatted).toContain('07:00:00');
      expect(formatted).toMatch(/EST|EDT/);
    });

    it('should use 6am ET as the business day start boundary', () => {
      const { start, end } = getEasternDateRange('today');
      const startTime = formatInTimeZone(start, EASTERN_TIMEZONE, 'HH:mm:ss');
      const endTime   = formatInTimeZone(end,   EASTERN_TIMEZONE, 'HH:mm:ss');
      const startDate = formatInTimeZone(start, EASTERN_TIMEZONE, 'yyyy-MM-dd');
      const endDate   = formatInTimeZone(end,   EASTERN_TIMEZONE, 'yyyy-MM-dd');

      // Business day must start at 6am ET
      expect(startTime).toBe('06:00:00');
      // Business day must end at 05:59:59 ET (next calendar day)
      expect(endTime).toMatch(/^05:59:59/);
      // Start and end are on different calendar dates
      expect(startDate).not.toBe(endDate);
    });

    it('should return yesterday as a distinct prior business day', () => {
      const { start: todayStart } = getEasternDateRange('today');
      const { start: yesterdayStart, end: yesterdayEnd } = getEasternDateRange('yesterday');

      const todayStartDate     = formatInTimeZone(todayStart,     EASTERN_TIMEZONE, 'yyyy-MM-dd');
      const yesterdayStartDate = formatInTimeZone(yesterdayStart, EASTERN_TIMEZONE, 'yyyy-MM-dd');
      const yesterdayEndDate   = formatInTimeZone(yesterdayEnd,   EASTERN_TIMEZONE, 'yyyy-MM-dd');
      const yesterdayStartTime = formatInTimeZone(yesterdayStart, EASTERN_TIMEZONE, 'HH:mm:ss');

      // Yesterday's start must be one calendar day before today's start
      expect(yesterdayStartDate).not.toBe(todayStartDate);
      // Yesterday's window must also start at 6am ET
      expect(yesterdayStartTime).toBe('06:00:00');
      // Yesterday's end (05:59:59 ET next day) lands on today's calendar date
      expect(yesterdayEndDate).toBe(todayStartDate);
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
        closedAt: new Date('2025-02-28T14:00:00Z')
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

  describe('6am Business Day Boundary Queries', () => {
    beforeEach(async () => {
      await db.execute(sql`DELETE FROM orders WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'`);

      // EST offset is UTC-5 (February is always EST, not EDT)
      // Feb 27 business day: Feb 27 06:00 ET (11:00 UTC) → Feb 28 05:59 ET (10:59 UTC)
      // Feb 28 business day: Feb 28 06:00 ET (11:00 UTC) → Mar 01 05:59 ET (10:59 UTC)
      const testOrders = [
        // In the Feb 27 business day (before 6am ET on Feb 28 = before 11:00 UTC Feb 28)
        getTestOrder({ createdAt: new Date('2025-02-28T04:59:00Z') }), // 11:59 PM ET Feb 27

        // In the Feb 28 business day (6am Feb 28 ET = 11:00 UTC Feb 28, through 5:59am Mar 1 ET)
        getTestOrder({ createdAt: new Date('2025-02-28T11:01:00Z') }), // 6:01 AM ET Feb 28
        getTestOrder({ createdAt: new Date('2025-02-28T16:00:00Z') }), // 11:00 AM ET Feb 28
        getTestOrder({ createdAt: new Date('2025-03-01T04:59:00Z') }), // 11:59 PM ET Feb 28

        // In the Mar 1 business day (6am Mar 1 ET = 11:00 UTC Mar 1)
        getTestOrder({ createdAt: new Date('2025-03-01T11:01:00Z') })  // 6:01 AM ET Mar 1
      ];

      for (const order of testOrders) {
        await pgStorage.createOrder(order);
      }
    });

    it('should count orders in a 6am–6am business day window', async () => {
      // Feb 28 business day: 2025-02-28T11:00:00Z → 2025-03-01T10:59:59Z
      const result = await db.execute(sql`
        SELECT COUNT(*) FROM orders
        WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'
          AND created_at >= '2025-02-28T11:00:00Z'
          AND created_at <  '2025-03-01T11:00:00Z'
      `);

      // Should include the 3 orders in the Feb 28 business day
      expect(Number(result.rows[0].count)).toBe(3);
    });

    it('should correctly exclude early-morning orders from the current business day', async () => {
      // The 11:59 PM ET order (04:59 UTC Feb 28) is in the Feb 27 business day, not Feb 28
      const result = await db.execute(sql`
        SELECT COUNT(*) FROM orders
        WHERE square_id LIKE 'TEST_TIMESTAMP_ORDER%'
          AND created_at < '2025-02-28T11:00:00Z'
      `);

      expect(Number(result.rows[0].count)).toBe(1);
    });
  });
});
