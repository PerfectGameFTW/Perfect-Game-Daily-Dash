/**
 * Dashboard Service
 * 
 * Provides a unified API for all dashboard-related data.
 * Coordinates with other services to gather and format data.
 */

import { orderService } from './orderService';
import { paymentService } from './paymentService';
import { giftCardService } from './giftCardService';
import { payoutService } from './payoutService';
import { intercardService } from './intercardService';
import { fetchGiftCardRedeemActivities, fetchGiftCardActivateActivity } from '../squareClient';
import { 
  type DateRange,
  type DailySummary,
  type CategoryRevenue,
  type HourlyRevenue,
  type GiftCardSummary,
  type ProcessingFeeBreakdown,
  refunds,
  transactions,
  orders as ordersTable
} from '../../shared/schema';
import { getEasternDateRange } from '../dateUtils';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger, errorContext } from '../logger';

export class DashboardService {
  /**
   * Get a complete daily summary for the dashboard
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns DailySummary with current and previous period data
   */
  async getDailySummary(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<DailySummary> {
    logger.info('dashboard.dailySummary.start', {
      dateRange,
      startDate: startDate?.toISOString(),
      endDate: endDate?.toISOString(),
    });

    const revenueBreakdown = await paymentService.getRevenueBreakdown(dateRange, startDate, endDate);
    const intercardCurrent = await intercardService.getRevenueForDateRange(dateRange, startDate, endDate);
    const totalRevenue = revenueBreakdown.trueRevenue + intercardCurrent.total;
    const depositClearings = revenueBreakdown.depositClearings;
    const partywirksDeposits = revenueBreakdown.partywirksDeposits;
    const tripleseatDeposits = revenueBreakdown.tripleseatDeposits;
    const totalOrders = await orderService.getTotalOrders(dateRange, startDate, endDate);
    const giftCardSales = await giftCardService.getGiftCardSales(dateRange, startDate, endDate);
    
    // Calculate previous period dates
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    const periodDuration = end.getTime() - start.getTime();
    const previousStart = new Date(start.getTime() - periodDuration - 1); // -1 to avoid overlapping
    const previousEnd = new Date(end.getTime() - periodDuration - 1);
    
    logger.info('dashboard.dailySummary.previousPeriod', {
      previousStart: previousStart.toISOString(),
      previousEnd: previousEnd.toISOString(),
    });
    
    const previousSquareRevenue = await paymentService.getTotalRevenue('custom', previousStart, previousEnd);
    const previousIntercard = await intercardService.getRevenueForDateRange('custom', previousStart, previousEnd);
    const previousRevenue = previousSquareRevenue + previousIntercard.total;
    const previousOrders = await orderService.getTotalOrders('custom', previousStart, previousEnd);
    const previousGiftCardSales = await giftCardService.getGiftCardSales('custom', previousStart, previousEnd);
    
    // Calculate changes
    const revenueChange = previousRevenue > 0 
      ? (totalRevenue - previousRevenue) / previousRevenue 
      : 0;
    
    const ordersChange = previousOrders > 0 
      ? (totalOrders - previousOrders) / previousOrders 
      : 0;
    
    const averageOrder = totalOrders > 0 
      ? totalRevenue / totalOrders 
      : 0;
    
    const previousAverageOrder = previousOrders > 0 
      ? previousRevenue / previousOrders 
      : 0;
    
    const averageOrderChange = previousAverageOrder > 0 
      ? (averageOrder - previousAverageOrder) / previousAverageOrder 
      : 0;
    
    const giftCardSalesChange = previousGiftCardSales > 0 
      ? (giftCardSales - previousGiftCardSales) / previousGiftCardSales 
      : 0;
    
    // Format date for display
    const date = new Date().toISOString().split('T')[0];
    
    logger.info('dashboard.dailySummary.done', {
      dateRange,
      totalOrders,
      previousOrders,
    });

    return {
      totalRevenue,
      grossPayments: revenueBreakdown.grossPayments + intercardCurrent.total,
      refunds: revenueBreakdown.refunds,
      returns: revenueBreakdown.returns,
      giftCardRedemptions: revenueBreakdown.giftCardRedemptions,
      depositClearings,
      partywirksDeposits,
      tripleseatDeposits,
      revenueChange,
      totalOrders,
      ordersChange,
      averageOrder,
      averageOrderChange,
      giftCardSales,
      giftCardSalesChange,
      date
    };
  }
  
  /**
   * Get category revenue for the dashboard
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Array of CategoryRevenue with colors
   */
  async getCategoryRevenue(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<CategoryRevenue[]> {
    return await orderService.getCategoryRevenue(dateRange, startDate, endDate);
  }
  
  /**
   * Get hourly revenue for the dashboard
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Array of HourlyRevenue
   */
  async getHourlyRevenue(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<HourlyRevenue[]> {
    // First try to get hourly revenue from payment service (transactions)
    // This ensures we get revenue data even if we don't have orders
    const paymentHourlyRevenue = await paymentService.getHourlyRevenue(dateRange, startDate, endDate);
    
    // If we have payment data, return it
    if (paymentHourlyRevenue && paymentHourlyRevenue.length > 0) {
      logger.info('dashboard.hourlyRevenue.fromPayments', { count: paymentHourlyRevenue.length });
      return paymentHourlyRevenue;
    }
    
    // Fallback to order service if payment service returns no data
    logger.info('dashboard.hourlyRevenue.fallbackToOrders');
    return await orderService.getHourlyRevenue(dateRange, startDate, endDate);
  }
  
  /**
   * Get gift card summary for the dashboard
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns GiftCardSummary with sales and redemptions
   */
  async getGiftCardSummary(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<GiftCardSummary> {
    return await giftCardService.getGiftCardSummary(dateRange, startDate, endDate);
  }
  
  /**
   * Get detailed transactions breakdown
   * This is a specialized method that computes various categories
   * of transactions for the detailed transactions view
   * 
   * @param dateRange The date range
   * @param startDate Optional custom start date
   * @param endDate Optional custom end date
   * @returns Detailed breakdown of transaction types
   */
  async getDetailedTransactionBreakdown(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<{
    partywirks: number;
    tripleseat: number;
    tips: number;
    serviceCharges: number;
    autoGratuity: number;
    taxes: number;
    refunds: number;
    returns: number;
    discountsAndComps: number;
    bowlingWebResDeposits: number;
    laserTagWebResDeposits: number;
    giftCardSales: number;
    giftCardRedemptions: number;
    gcRedemptionBreakdown: {
      bowlingDepositRedemptions: number;
      laserTagDepositRedemptions: number;
      giftCardRedemptions: number;
    };
    depositClearings: number;
    processingFees: ProcessingFeeBreakdown;
    intercardRevenue: number;
    intercardCashRevenue: number;
    intercardCreditRevenue: number;
    squareIntercardKioskCash: number;
    totalTransactions: number;
  }> {
    let partywirks = 0;
    let tripleseat = 0;
    let serviceCharges = 0;
    let autoGratuity = 0;
    let taxes = 0;
    let refundsTotal = 0;
    let returnsTotal = 0;
    let discountsAndComps = 0;

    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

    const [tips, depositClearingsResult, txCountResult] = await Promise.all([
      paymentService.getTipsByDateRange(dateRange, startDate, endDate),
      paymentService.getDepositClearings(dateRange, startDate, endDate),
      db.execute<{ cnt: number }>(sql`
        SELECT COUNT(*) as cnt FROM ${transactions}
        WHERE ${transactions.timestamp} BETWEEN ${start} AND ${end}
          AND ${transactions.status} = 'completed'
      `),
    ]);
    const totalTransactionCount = Number(txCountResult.rows[0]?.cnt || 0);
    const depositClearings = depositClearingsResult.total;

    const refundRows = await db.execute<{ total: number }>(sql`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM ${refunds}
      WHERE ${refunds.createdAt} BETWEEN ${start} AND ${end}
        AND ${refunds.status} IN ('COMPLETED', 'PENDING')
        AND (${refunds.reason} IS NULL OR ${refunds.reason} = '')
    `);
    refundsTotal = Number(refundRows.rows[0]?.total || 0);

    const returnRefundRows = await db.execute<{ total: number; return_tax: number }>(sql`
      SELECT 
        COALESCE(SUM(r.amount), 0) as total,
        COALESCE(SUM(DISTINCT CASE 
          WHEN o.square_data->'returnAmounts'->'taxMoney'->>'amount' IS NOT NULL
          THEN (o.square_data->'returnAmounts'->'taxMoney'->>'amount')::numeric / 100
          ELSE 0 
        END), 0) as return_tax
      FROM ${refunds} r
      LEFT JOIN ${ordersTable} o ON o.square_id = r.square_data->>'orderId'
      WHERE r.created_at BETWEEN ${start} AND ${end}
        AND r.status IN ('COMPLETED', 'PENDING')
        AND r.reason IS NOT NULL AND r.reason != ''
    `);
    returnsTotal = Number(returnRefundRows.rows[0]?.total || 0) - Number(returnRefundRows.rows[0]?.return_tax || 0);
    
    // Get gift card breakdown: bowling deposits, laser tag deposits, actual gift card sales
    const giftCardBreakdown = await giftCardService.getGiftCardBreakdown(dateRange, startDate, endDate);

    const gcRedemptionTotalRows = await db.execute<{ total: number }>(sql`
      SELECT COALESCE(SUM((tender->'amountMoney'->>'amount')::numeric / 100), 0) as total
      FROM ${ordersTable} o
      CROSS JOIN LATERAL jsonb_array_elements(o.square_data->'tenders') as tender
      WHERE tender->>'type' = 'SQUARE_GIFT_CARD'
        AND o.status = 'COMPLETED'
        AND COALESCE(o.closed_at, o.created_at) BETWEEN ${start} AND ${end}
    `);
    const giftCardRedemptionsTotal = Number(gcRedemptionTotalRows.rows[0]?.total || 0);

    let bowlingRedemptions = 0;
    let laserTagRedemptions = 0;
    let pureGcRedemptions = giftCardRedemptionsTotal;

    if (giftCardRedemptionsTotal > 0) {
      try {
        const redeemActivities = await fetchGiftCardRedeemActivities(
          start.toISOString(),
          end.toISOString()
        );

        let dbResolved = 0;
        let fallbackAttempted = 0;
        let fallbackSuccesses = 0;
        let fallbackFailures = 0;

        if (redeemActivities.length > 0) {
          const uniqueGcIds = Array.from(new Set(redeemActivities.map(a => a.giftCardId)));
          const activationSourceRows = await db.execute<{
            square_id: string;
            source: string | null;
            has_deposit_item: boolean;
          }>(sql`
            SELECT gc.square_id, o.source,
              COALESCE(EXISTS (
                SELECT 1 FROM order_line_items oli
                WHERE oli.order_id = o.id AND oli.name = 'Deposit'
              ), false) AS has_deposit_item
            FROM gift_cards gc
            LEFT JOIN ${ordersTable} o ON o.square_id = gc.activation_square_order_id
            WHERE gc.square_id IN ${sql`(${sql.join(uniqueGcIds.map(id => sql`${id}`), sql`, `)})`}
          `);

          const classificationMap = new Map<string, { source: string | null; hasDepositItem: boolean }>();
          for (const row of activationSourceRows.rows) {
            classificationMap.set(row.square_id, {
              source: row.source,
              hasDepositItem: row.has_deposit_item,
            });
          }
          dbResolved = activationSourceRows.rows.filter(r => r.source !== null).length;

          const unresolvedGcIds = uniqueGcIds.filter(id =>
            !classificationMap.has(id) || classificationMap.get(id)?.source === null
          );
          fallbackAttempted = unresolvedGcIds.length;
          if (unresolvedGcIds.length > 0) {
            const gcToOrderId = new Map<string, string>();
            const activatePromises = unresolvedGcIds.map(async (gcId) => {
              const activateResult = await fetchGiftCardActivateActivity(gcId);
              if (activateResult?.squareOrderId) {
                gcToOrderId.set(gcId, activateResult.squareOrderId);
              }
            });
            await Promise.all(activatePromises);

            if (gcToOrderId.size > 0) {
              const orderIds = Array.from(gcToOrderId.values());
              const orderRows = await db.execute<{
                square_id: string;
                source: string;
                has_deposit_item: boolean;
              }>(sql`
                SELECT o.square_id, o.source,
                  EXISTS (
                    SELECT 1 FROM order_line_items oli
                    WHERE oli.order_id = o.id AND oli.name = 'Deposit'
                  ) AS has_deposit_item
                FROM ${ordersTable} o
                WHERE o.square_id IN ${sql`(${sql.join(orderIds.map(id => sql`${id}`), sql`, `)})`}
              `);
              const orderInfoMap = new Map<string, { source: string; hasDepositItem: boolean }>();
              for (const row of orderRows.rows) {
                orderInfoMap.set(row.square_id, {
                  source: row.source,
                  hasDepositItem: row.has_deposit_item,
                });
              }
              for (const [gcId, orderId] of Array.from(gcToOrderId.entries())) {
                const info = orderInfoMap.get(orderId);
                if (info) {
                  classificationMap.set(gcId, info);
                  fallbackSuccesses++;
                }
              }
            }
            fallbackFailures = unresolvedGcIds.length - fallbackSuccesses;
          }

          for (const activity of redeemActivities) {
            const info = classificationMap.get(activity.giftCardId);
            const hasDeposit = info?.hasDepositItem ?? false;
            const source = info?.source ?? null;
            const isLaserTag = source === 'Web Reservation-Attraction' || source === 'Multi Attractions Reservation';
            if (hasDeposit && !isLaserTag) {
              bowlingRedemptions += activity.amountDollars;
            } else if (hasDeposit && isLaserTag) {
              laserTagRedemptions += activity.amountDollars;
            }
          }

          pureGcRedemptions = Math.max(0, giftCardRedemptionsTotal - bowlingRedemptions - laserTagRedemptions);
        }

        const classifiedSum = bowlingRedemptions + laserTagRedemptions + pureGcRedemptions;
        const hasMismatch = Math.abs(classifiedSum - giftCardRedemptionsTotal) > 0.01;
        if (hasMismatch) {
          logger.warn('gcRedemption.reconciliation_mismatch');
        }
        logger.info('gcRedemption.fetched', {
          count: redeemActivities.length,
          dbResolved,
          fallbackAttempted,
          fallbackOk: fallbackSuccesses,
          fallbackFail: fallbackFailures,
          mismatch: hasMismatch,
        });
      } catch (error) {
        logger.error('gcRedemption.fetch_failed', errorContext(error));
        pureGcRedemptions = giftCardRedemptionsTotal;
      }
    }
    
    // Calculate taxes from ALL orders (COMPLETED + OPEN) in the date range.
    // Square's Sales Summary includes tax from every order for the business day,
    // regardless of payment status.
    const taxRows = await db.execute<{ tax_total: number }>(sql`
      SELECT COALESCE(SUM(${ordersTable.totalTax}), 0) as tax_total
      FROM ${ordersTable}
      WHERE COALESCE(${ordersTable.closedAt}, ${ordersTable.createdAt}) BETWEEN ${start} AND ${end}
        AND ${ordersTable.status} IN ('COMPLETED', 'OPEN')
    `);
    taxes = Math.max(Number(taxRows.rows[0]?.tax_total || 0), 0);

    // Get order data to calculate discounts, service charges, and 3rd-party deposit sources
    const orders = await orderService.getOrdersByDateRange(dateRange, startDate, endDate);
    
    for (const order of orders) {
      if (order.totalDiscount && order.status === 'COMPLETED') {
        discountsAndComps += order.totalDiscount;
      }

      const src: string = order.source || '';
      if (src === 'Perfect Game Partywirks') {
        partywirks += order.totalMoney || 0;
      } else if (src === 'Tripleseat') {
        tripleseat += order.totalMoney || 0;
      }

      const rawOrderData = (order as any).square_data ?? order.squareData;
      const orderData: any = rawOrderData
        ? (typeof rawOrderData === 'string' ? JSON.parse(rawOrderData) : rawOrderData)
        : {};
      if (orderData?.serviceCharges && Array.isArray(orderData.serviceCharges)) {
        for (const charge of orderData.serviceCharges) {
          if (charge.appliedMoney?.amount) {
            const amount = Number(charge.appliedMoney.amount) / 100;
            if (charge.type === 'AUTO_GRATUITY') {
              autoGratuity += amount;
            } else {
              serviceCharges += amount;
            }
          }
        }
      }
    }
    
    let processingFees: ProcessingFeeBreakdown = { initialFees: 0, reimbursements: 0, thirdPartyFees: 0, netFees: 0 };
    try {
      processingFees = await payoutService.getProcessingFees(dateRange, startDate, endDate);
    } catch (err) {
      logger.error('dashboard.processingFees.fetch_failed', errorContext(err));
    }

    let intercardBreakdown = { cash: 0, credit: 0, total: 0 };
    try {
      intercardBreakdown = await intercardService.getRevenueForDateRange(dateRange, startDate, endDate);
    } catch (err) {
      logger.error('dashboard.intercard.fetch_failed', errorContext(err));
    }

    let squareIntercardKioskCash = 0;
    try {
      squareIntercardKioskCash = await paymentService.getIntercardKioskCashTotal(dateRange, startDate, endDate);
    } catch (err) {
      logger.error('dashboard.intercardKioskCash.fetch_failed', errorContext(err));
    }

    return {
      partywirks,
      tripleseat,
      tips,
      serviceCharges,
      autoGratuity,
      taxes,
      refunds: refundsTotal,
      returns: returnsTotal,
      discountsAndComps,
      bowlingWebResDeposits: giftCardBreakdown.bowlingWebResDeposits,
      laserTagWebResDeposits: giftCardBreakdown.laserTagWebResDeposits,
      giftCardSales: giftCardBreakdown.giftCardSales,
      giftCardRedemptions: giftCardRedemptionsTotal,
      gcRedemptionBreakdown: {
        bowlingDepositRedemptions: bowlingRedemptions,
        laserTagDepositRedemptions: laserTagRedemptions,
        giftCardRedemptions: pureGcRedemptions,
      },
      depositClearings,
      processingFees,
      intercardRevenue: intercardBreakdown.total,
      intercardCashRevenue: intercardBreakdown.cash,
      intercardCreditRevenue: intercardBreakdown.credit,
      squareIntercardKioskCash,
      totalTransactions: totalTransactionCount
    };
  }
}

// Create and export a singleton instance
export const dashboardService = new DashboardService();