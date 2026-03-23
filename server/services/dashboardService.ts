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
    console.log(`Getting daily summary with UTC dates: {
  dateRange: '${dateRange}',
  startUTC: '${startDate?.toISOString() || 'undefined'}',
  endUTC: '${endDate?.toISOString() || 'undefined'}'
}`);

    // Get current period data with full revenue breakdown
    const revenueBreakdown = await paymentService.getRevenueBreakdown(dateRange, startDate, endDate);
    const totalRevenue = revenueBreakdown.trueRevenue;
    const totalOrders = await orderService.getTotalOrders(dateRange, startDate, endDate);
    const giftCardSales = await giftCardService.getGiftCardSales(dateRange, startDate, endDate);
    
    // Calculate previous period dates
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    const periodDuration = end.getTime() - start.getTime();
    const previousStart = new Date(start.getTime() - periodDuration - 1); // -1 to avoid overlapping
    const previousEnd = new Date(end.getTime() - periodDuration - 1);
    
    console.log(`Previous period UTC dates: {
  previousStartUTC: '${previousStart.toISOString()}',
  previousEndUTC: '${previousEnd.toISOString()}'
}`);
    
    // Get previous period data for comparison (also uses true revenue)
    const previousRevenue = await paymentService.getTotalRevenue('custom', previousStart, previousEnd);
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
    
    console.log(`Daily summary calculated with UTC: {
  dateRange: '${dateRange}',
  totalRevenue: ${totalRevenue},
  giftCardSales: ${giftCardSales},
  previousRevenue: ${previousRevenue},
  previousGiftCardSales: ${previousGiftCardSales},
  totalOrders: ${totalOrders},
  previousOrders: ${previousOrders}
}`);

    return {
      totalRevenue,
      grossPayments: revenueBreakdown.grossPayments,
      refunds: revenueBreakdown.refunds,
      returns: revenueBreakdown.returns,
      giftCardRedemptions: revenueBreakdown.giftCardRedemptions,
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
      console.log(`Found ${paymentHourlyRevenue.length} hourly revenue entries from payment service`);
      return paymentHourlyRevenue;
    }
    
    // Fallback to order service if payment service returns no data
    console.log('No hourly revenue data from payment service, falling back to order service');
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
    totalTransactions: number;
  }> {
    // Get payments for the specified date range
    const payments = await paymentService.getPaymentsByDateRange(
      dateRange,
      'completed',
      startDate,
      endDate
    );
    
    // Initialize values
    let partywirks = 0;
    let tripleseat = 0;
    let tips = 0;
    let serviceCharges = 0;
    let autoGratuity = 0;
    let taxes = 0;
    let refundsTotal = 0;
    let returnsTotal = 0;
    let discountsAndComps = 0;
    let depositClearings = 0;
    
    // Calculate values from payments
    for (const payment of payments) {
      const rawData = (payment as any).square_data ?? payment.squareData;
      const squareData: Record<string, any> = rawData
        ? (typeof rawData === 'string' ? JSON.parse(rawData) : rawData)
        : {};
      
      if (squareData.tipMoney?.amount) {
        tips += Number(squareData.tipMoney.amount) / 100;
      }
      
      if (
        squareData.sourceType === 'EXTERNAL' &&
        squareData.externalDetails?.type === 'OTHER'
      ) {
        depositClearings += payment.amount;
      }
    }

    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

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

    const gcRedemptionRows = await db.execute<{
      total: number;
      bowling_redemptions: number;
      laser_tag_redemptions: number;
      gc_redemptions: number;
    }>(sql`
      SELECT
        COALESCE(SUM(tender_amount), 0) as total,
        COALESCE(SUM(CASE WHEN activation_source = 'Web Reservation' THEN tender_amount ELSE 0 END), 0) as bowling_redemptions,
        COALESCE(SUM(CASE WHEN activation_source = 'Web Reservation-Attraction' THEN tender_amount ELSE 0 END), 0) as laser_tag_redemptions,
        COALESCE(SUM(CASE WHEN activation_source IS NULL
                           OR activation_source NOT IN ('Web Reservation', 'Web Reservation-Attraction')
                      THEN tender_amount ELSE 0 END), 0) as gc_redemptions
      FROM (
        SELECT DISTINCT ON (o.square_id, tender->>'id')
          (tender->'amountMoney'->>'amount')::numeric / 100 as tender_amount,
          activation_order.source as activation_source
        FROM ${ordersTable} o
        CROSS JOIN LATERAL jsonb_array_elements(o.square_data->'tenders') as tender
        LEFT JOIN gift_cards gc ON RIGHT(gc.gan, 4) = tender->'cardDetails'->'card'->>'last4'
          AND gc.gan IS NOT NULL
        LEFT JOIN ${ordersTable} activation_order ON activation_order.square_id = gc.activation_square_order_id
        WHERE tender->>'type' = 'SQUARE_GIFT_CARD'
          AND o.status = 'COMPLETED'
          AND COALESCE(o.closed_at, o.created_at) BETWEEN ${start} AND ${end}
        ORDER BY o.square_id, tender->>'id',
          gc.activation_square_order_id IS NOT NULL DESC,
          gc.id DESC
      ) sub
    `);
    const giftCardRedemptionsTotal = Number(gcRedemptionRows.rows[0]?.total || 0);
    const bowlingRedemptions = Number(gcRedemptionRows.rows[0]?.bowling_redemptions || 0);
    const laserTagRedemptions = Number(gcRedemptionRows.rows[0]?.laser_tag_redemptions || 0);
    const pureGcRedemptions = Number(gcRedemptionRows.rows[0]?.gc_redemptions || 0);
    
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
      console.error('Error fetching processing fees:', err);
    }

    let intercardTotal = 0;
    try {
      intercardTotal = await intercardService.getRevenueForDateRange(dateRange, startDate, endDate);
    } catch (err) {
      console.error('Error fetching Intercard revenue:', err);
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
      intercardRevenue: intercardTotal,
      totalTransactions: payments.length
    };
  }
}

// Create and export a singleton instance
export const dashboardService = new DashboardService();