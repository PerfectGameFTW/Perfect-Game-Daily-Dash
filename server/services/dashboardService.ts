/**
 * Dashboard Service
 * 
 * Provides a unified API for all dashboard-related data.
 * Coordinates with other services to gather and format data.
 */

import { orderService } from './orderService';
import { paymentService } from './paymentService';
import { giftCardService } from './giftCardService';
import { 
  type DateRange,
  type DailySummary,
  type CategoryRevenue,
  type HourlyRevenue,
  type GiftCardSummary
} from '../../shared/schema';
import { getEasternDateRange } from '../dateUtils';

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

    // Get current period data
    const totalRevenue = await paymentService.getTotalRevenue(dateRange, startDate, endDate);
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
    
    // Get previous period data for comparison
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
    taxes: number;
    refunds: number;
    discountsAndComps: number;
    giftCardSales: number;
  }> {
    // Get date range parameters
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
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
    let taxes = 0;
    let refunds = 0;
    let discountsAndComps = 0;
    
    // Calculate values from payments
    for (const payment of payments) {
      // Extract category and other details from squareData
      const squareData = payment.squareData ? (typeof payment.squareData === 'string' 
        ? JSON.parse(payment.squareData) 
        : payment.squareData as Record<string, any>) : {};
      
      // Process based on type
      if (squareData.category === 'partywirks') {
        partywirks += payment.amount;
      } else if (squareData.category === 'tripleseat') {
        tripleseat += payment.amount;
      }
      
      // Add tips - extract from squareData if available
      const tipAmount = squareData.tipAmount || 0;
      if (tipAmount) {
        tips += tipAmount;
      }
      
      // Add taxes - extract from squareData if available
      const taxAmount = squareData.taxAmount || 0;
      if (taxAmount) {
        taxes += taxAmount;
      }
      
      // Process refunds (negative amounts)
      if (payment.amount < 0) {
        refunds += Math.abs(payment.amount);
      }
    }
    
    // Get gift card sales for the period
    const giftCardSales = await giftCardService.getGiftCardSales(dateRange, startDate, endDate);
    
    // Get order data to calculate discounts
    const orders = await orderService.getOrdersByDateRange(dateRange, startDate, endDate);
    
    // Calculate discounts from orders
    for (const order of orders) {
      if (order.totalDiscount) {
        discountsAndComps += order.totalDiscount;
      }
    }
    
    return {
      partywirks,
      tripleseat,
      tips,
      serviceCharges,
      taxes,
      refunds,
      discountsAndComps,
      giftCardSales
    };
  }
}

// Create and export a singleton instance
export const dashboardService = new DashboardService();