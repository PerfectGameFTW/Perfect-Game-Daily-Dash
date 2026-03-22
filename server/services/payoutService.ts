import { Client, Environment } from 'square';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { payoutFeeEntries } from '../../shared/schema';
import { syncService } from './syncService';
import { getEasternDateRange } from '../dateUtils';
import type { DateRange, InsertPayoutFeeEntry } from '../../shared/schema';

const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN || '',
  environment: Environment.Production
});

const payoutsApi = squareClient.payoutsApi;

interface PayoutSyncResult {
  payoutsProcessed: number;
  entriesCreated: number;
  entriesSkipped: number;
}

export class PayoutService {
  async syncPayoutFees(sinceDate?: Date): Promise<PayoutSyncResult> {
    const locationId = process.env.SQUARE_LOCATION_ID;
    if (!locationId) throw new Error('SQUARE_LOCATION_ID not configured');

    const beginTime = sinceDate?.toISOString() ?? '2025-01-01T00:00:00Z';
    let cursor: string | undefined;
    let payoutsProcessed = 0;
    let entriesCreated = 0;
    let entriesSkipped = 0;

    do {
      const response = await payoutsApi.listPayouts(
        locationId,
        undefined,
        beginTime,
        undefined,
        'ASC',
        cursor,
        100
      );

      const payouts = response.result.payouts || [];
      cursor = response.result.cursor as string | undefined;

      for (const payout of payouts) {
        if (!payout.id) continue;
        payoutsProcessed++;

        let entryCursor: string | undefined;
        do {
          const entryResponse = await payoutsApi.listPayoutEntries(
            payout.id,
            undefined,
            entryCursor,
            100
          );

          const entries = entryResponse.result.payoutEntries || [];
          entryCursor = entryResponse.result.cursor as string | undefined;

          const batch: InsertPayoutFeeEntry[] = [];
          for (const entry of entries) {
            if (!entry.id || !entry.type) continue;

            const validTypes = ['CHARGE', 'FEE', 'THIRD_PARTY_FEE', 'THIRD_PARTY_FEE_REFUND'];
            if (!validTypes.includes(entry.type)) continue;

            const gross = entry.grossAmountMoney?.amount
              ? Number(entry.grossAmountMoney.amount) / 100
              : 0;
            const fee = entry.feeAmountMoney?.amount
              ? Number(entry.feeAmountMoney.amount) / 100
              : 0;
            const net = entry.netAmountMoney?.amount
              ? Number(entry.netAmountMoney.amount) / 100
              : 0;

            let paymentId: string | null = null;
            const details = entry as Record<string, unknown>;
            if (entry.type === 'CHARGE') {
              const chargeDetails = details.typeChargeDetails as Record<string, string> | undefined;
              paymentId = chargeDetails?.paymentId ?? null;
            } else if (entry.type === 'FEE') {
              const feeDetails = details.typeFeeDetails as Record<string, string> | undefined;
              paymentId = feeDetails?.paymentId ?? null;
            }

            batch.push({
              payoutId: payout.id,
              entryId: entry.id,
              type: entry.type,
              effectiveAt: new Date(entry.effectiveAt as string),
              grossAmount: gross,
              feeAmount: fee,
              netAmount: net,
              paymentId,
            });
          }

          if (batch.length > 0) {
            try {
              const result = await db.insert(payoutFeeEntries).values(batch)
                .onConflictDoNothing({ target: payoutFeeEntries.entryId });
              const inserted = result.rowCount ?? batch.length;
              entriesCreated += inserted;
              entriesSkipped += batch.length - inserted;
            } catch (err) {
              console.error(`[PayoutSync] Insert error for payout ${payout.id}:`, err instanceof Error ? err.message : err);
              entriesSkipped += batch.length;
            }
          }
        } while (entryCursor);
      }

      if (cursor) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } while (cursor);

    return { payoutsProcessed, entriesCreated, entriesSkipped };
  }

  async syncPayoutFeesIncremental(): Promise<PayoutSyncResult> {
    const state = await syncService.getSyncState('payout_fees');

    let sinceDate: Date;
    if (state?.lastSyncedAt) {
      sinceDate = new Date(state.lastSyncedAt.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else {
      sinceDate = new Date('2025-01-01T00:00:00Z');
    }

    console.log(`[PayoutSync] Syncing payout fees since ${sinceDate.toISOString()}`);
    const result = await this.syncPayoutFees(sinceDate);

    if (state) {
      await syncService.updateSyncState(state.id, {
        lastSyncedAt: new Date(),
        status: 'completed',
        isComplete: true,
      });
    } else {
      await syncService.createSyncState({
        syncType: 'payout_fees',
        lastSyncedAt: new Date(),
        status: 'completed',
        isComplete: true,
        currentPage: 0,
        totalPages: 0,
        processedCount: result.payoutsProcessed,
        totalCount: result.entriesCreated,
        cursor: '',
        errorMessage: null,
        lastCheckpoint: null,
      });
    }

    return result;
  }

  async getProcessingFees(dateRange: DateRange, startDate?: Date, endDate?: Date) {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

    const rows = await db.execute<{
      type: string;
      total_fee: number;
      total_net: number;
    }>(sql`
      SELECT 
        type,
        COALESCE(SUM(
          CASE 
            WHEN type = 'CHARGE' THEN fee_amount
            ELSE net_amount
          END
        ), 0) as total_fee,
        COALESCE(SUM(net_amount), 0) as total_net
      FROM payout_fee_entries
      WHERE effective_at BETWEEN ${start} AND ${end}
        AND type IN ('CHARGE', 'FEE', 'THIRD_PARTY_FEE', 'THIRD_PARTY_FEE_REFUND')
      GROUP BY type
    `);

    let initialFees = 0;
    let reimbursements = 0;
    let thirdPartyFees = 0;

    for (const row of rows.rows) {
      if (row.type === 'CHARGE') {
        initialFees = Math.abs(Number(row.total_fee));
      } else if (row.type === 'FEE') {
        reimbursements = Number(row.total_net);
      } else if (row.type === 'THIRD_PARTY_FEE') {
        thirdPartyFees = Math.abs(Number(row.total_net));
      } else if (row.type === 'THIRD_PARTY_FEE_REFUND') {
        thirdPartyFees -= Math.abs(Number(row.total_net));
      }
    }

    const netFees = initialFees - reimbursements + thirdPartyFees;

    return { initialFees, reimbursements, thirdPartyFees, netFees };
  }
}

export const payoutService = new PayoutService();
