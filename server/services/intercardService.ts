import { db } from '../db';
import { eq, sql } from 'drizzle-orm';
import { intercardRevenue, syncState, type DateRange } from '../../shared/schema';
import { getEasternDateRange } from '../dateUtils';

const INTERCARD_HOST = (process.env.INTERCARD_HOST || 'https://development.intercardinc.com').replace(/\/+$/, '');
const INTERCARD_MAC_ID = process.env.INTERCARD_MAC_ID || '';
const INTERCARD_CORP_ID = process.env.INTERCARD_CORP_ID || '';
const INTERCARD_BASE_PATH = '/WS_RevenueExtract_REST/Revenue';
const INTERCARD_TOKEN_PATH = '/WS_RevenueExtract_REST/api/Tokens/corp';

interface IntercardRevenueRow {
  LocationID: string;
  DeviceType: string;
  DeviceName: string;
  CashRevenue: number;
  CreditCardRevenue: number;
  CashRefunds: number;
  CreditRefunds: number;
  OtherPayment: number;
  CustomerCardUse: number;
  Revenue: number;
}

function formatDateET(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  return parts;
}

function getEasternUtcOffset(d: Date): number {
  const jan = new Date(d.getFullYear(), 0, 1);
  const jul = new Date(d.getFullYear(), 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  const eastern = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const diffMinutes = Math.round((eastern.getTime() - utc.getTime()) / 60000);
  return diffMinutes;
}

export class IntercardService {
  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  private async getAuthToken(): Promise<string | null> {
    if (!INTERCARD_CORP_ID) {
      return null;
    }

    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const url = `${INTERCARD_HOST}${INTERCARD_TOKEN_PATH}/${INTERCARD_CORP_ID}/GetJwt`;
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) {
        console.error(`[Intercard] Auth token error ${response.status}: ${await response.text()}`);
        return null;
      }
      const token = await response.text();
      this.cachedToken = token.replace(/^"|"$/g, '');
      this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
      console.log('[Intercard] Auth token acquired');
      return this.cachedToken;
    } catch (err) {
      console.error('[Intercard] Auth token fetch error:', err);
      return null;
    }
  }

  async fetchRevenueReportByDateStr(startDateStr: string, endDateStr?: string): Promise<IntercardRevenueRow[]> {
    const dateForOffset = new Date(startDateStr + 'T12:00:00');
    const utcOffset = String(getEasternUtcOffset(dateForOffset));
    return this.fetchRevenueReportRaw(startDateStr, endDateStr || startDateStr, utcOffset);
  }

  private async fetchRevenueReportRaw(startDateStr: string, endDateStr: string, utcOffset: string): Promise<IntercardRevenueRow[]> {
    if (!INTERCARD_MAC_ID) {
      console.warn('[Intercard] INTERCARD_MAC_ID not set — skipping fetch');
      return [];
    }

    const params = new URLSearchParams({
      macId: INTERCARD_MAC_ID,
      startdate: startDateStr,
      enddate: endDateStr,
      utcOffset,
      isBusinessDay: 'true',
    });

    const url = `${INTERCARD_HOST}${INTERCARD_BASE_PATH}?${params.toString()}`;
    console.log(`[Intercard] Fetching revenue: ${url}`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const headers: Record<string, string> = { 'Accept': 'application/json' };
      const token = await this.getAuthToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        signal: controller.signal,
        headers,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        console.error(`[Intercard] API error ${response.status}: ${text}`);
        return [];
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        console.error('[Intercard] Unexpected response format:', typeof data);
        return [];
      }

      console.log(`[Intercard] Fetched ${data.length} revenue rows`);
      return data as IntercardRevenueRow[];
    } catch (err) {
      console.error('[Intercard] Fetch error:', err);
      return [];
    }
  }

  async syncSingleDay(dateStr: string): Promise<{
    fetched: number;
    upserted: number;
    failed: number;
  }> {
    const result = { fetched: 0, upserted: 0, failed: 0 };

    const rows = await this.fetchRevenueReportByDateStr(dateStr);
    result.fetched = rows.length;

    if (rows.length === 0) return result;

    await db.delete(intercardRevenue)
      .where(eq(intercardRevenue.date, dateStr));

    for (const row of rows) {
      try {
        await db.insert(intercardRevenue).values({
          date: dateStr,
          locationId: String(row.LocationID ?? ''),
          deviceType: String(row.DeviceType ?? ''),
          deviceName: String(row.DeviceName ?? ''),
          cashRevenue: Number(row.CashRevenue) || 0,
          creditCardRevenue: Number(row.CreditCardRevenue) || 0,
          cashRefunds: Number(row.CashRefunds) || 0,
          creditRefunds: Number(row.CreditRefunds) || 0,
          otherPayment: Number(row.OtherPayment) || 0,
          customerCardUse: Number(row.CustomerCardUse) || 0,
          revenue: Number(row.Revenue) || 0,
        });
        result.upserted++;
      } catch (err) {
        result.failed++;
        console.error('[Intercard] Insert error:', err);
      }
    }

    return result;
  }

  async syncToday(): Promise<void> {
    const todayStr = formatDateET(new Date());

    const dayResult = await this.syncSingleDay(todayStr);
    if (dayResult.upserted > 0) {
      console.log(`[Intercard] Today sync: ${dayResult.upserted} records`);
    }
  }

  async runHistoricalBackfill(): Promise<void> {
    const syncType = 'intercard_backfill';
    const existingState = await db.select().from(syncState)
      .where(eq(syncState.syncType, syncType))
      .limit(1);

    if (existingState.length > 0 && existingState[0].isComplete && existingState[0].status === 'completed') {
      console.log('[Intercard] Historical backfill already complete');
      return;
    }

    let checkpoint: any = existingState.length > 0 ? existingState[0].lastCheckpoint : null;
    const backfillStart = new Date('2025-01-01');
    const backfillEnd = new Date();

    let currentDate = checkpoint?.lastDate
      ? new Date(checkpoint.lastDate)
      : new Date(backfillStart);

    if (currentDate < backfillStart) currentDate = new Date(backfillStart);

    console.log(`[Intercard] Starting historical backfill from ${formatDateET(currentDate)} to ${formatDateET(backfillEnd)}`);

    if (existingState.length === 0) {
      await db.insert(syncState).values({
        syncType,
        lastSyncedAt: new Date(),
        isComplete: false,
        status: 'in_progress',
        processedCount: 0,
        totalCount: 0,
      });
    } else {
      await db.update(syncState)
        .set({ status: 'in_progress', lastSyncedAt: new Date() })
        .where(eq(syncState.syncType, syncType));
    }

    let daysProcessed = checkpoint?.daysProcessed || 0;

    while (currentDate <= backfillEnd) {
      const dateStr = formatDateET(currentDate);

      try {
        const dayResult = await this.syncSingleDay(dateStr);
        daysProcessed++;

        if (daysProcessed % 30 === 0) {
          console.log(`[Intercard] Backfill progress: ${daysProcessed} days, date=${dateStr}`);
        }

        await db.update(syncState)
          .set({
            lastSyncedAt: new Date(),
            processedCount: daysProcessed,
            lastCheckpoint: { lastDate: dateStr, daysProcessed },
          })
          .where(eq(syncState.syncType, syncType));
      } catch (err) {
        console.error(`[Intercard] Backfill error for ${dateStr}:`, err);
      }

      currentDate.setDate(currentDate.getDate() + 1);

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    await db.update(syncState)
      .set({
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date(),
        processedCount: daysProcessed,
      })
      .where(eq(syncState.syncType, syncType));

    console.log(`[Intercard] Historical backfill complete: ${daysProcessed} days processed`);
  }

  async getRevenueForDateRange(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date,
  ): Promise<number> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

    const startStr = formatDateET(start);
    const endStr = formatDateET(end);

    const result = await db.execute<{ total: number }>(sql`
      SELECT COALESCE(SUM(revenue), 0) as total
      FROM intercard_revenue
      WHERE date >= ${startStr} AND date <= ${endStr}
    `);

    return Number(result.rows[0]?.total || 0);
  }
}

export const intercardService = new IntercardService();
