import { apiRequest } from "./queryClient";
import { DateRange, DailySummary, GiftCardSummary, DetailedTransactionBreakdown, ProcessingFeeBreakdown, GcRedemptionBreakdown } from "@shared/schema";

const toFloat = (v: unknown): number => typeof v === 'number' ? v : parseFloat(String(v ?? 0)) || 0;
const toInt = (v: unknown): number => typeof v === 'number' ? v : parseInt(String(v ?? 0), 10) || 0;
const toStr = (v: unknown, fallback: string): string => typeof v === 'string' ? v : fallback;

// Helper to build query string
const buildQueryString = (
  dateRange: DateRange, 
  startDate?: Date, 
  endDate?: Date
): string => {
  let queryParams = `dateRange=${dateRange}`;
  
  if (startDate) {
    const startDateISO = startDate.toISOString();
    queryParams += `&startDate=${encodeURIComponent(startDateISO)}`;
    const finalEndDate = endDate || startDate;
    const endDateISO = finalEndDate.toISOString();
    queryParams += `&endDate=${encodeURIComponent(endDateISO)}`;
  }
  
  return queryParams;
};

export const fetchDailySummary = async (
  dateRange: DateRange = 'today',
  startDate?: Date,
  endDate?: Date
): Promise<DailySummary> => {
  try {
    const queryString = buildQueryString(dateRange, startDate, endDate);
    const response = await apiRequest('GET', `/api/summary?${queryString}`);
    
    const parseSummary = (d: Record<string, unknown>): DailySummary => ({
      totalRevenue: toFloat(d.totalRevenue),
      grossPayments: toFloat(d.grossPayments),
      refunds: toFloat(d.refunds),
      returns: toFloat(d.returns),
      giftCardRedemptions: toFloat(d.giftCardRedemptions),
      revenueChange: toFloat(d.revenueChange),
      totalOrders: toInt(d.totalOrders),
      ordersChange: toFloat(d.ordersChange),
      averageOrder: toFloat(d.averageOrder),
      averageOrderChange: toFloat(d.averageOrderChange),
      giftCardSales: toFloat(d.giftCardSales),
      giftCardSalesChange: toFloat(d.giftCardSalesChange),
      date: toStr(d.date, new Date().toISOString().split('T')[0])
    });

    if (typeof response === 'object' && response !== null) {
      return parseSummary(response);
    }
    
    if (response instanceof Response) {
      const data = await response.json();
      return parseSummary(data);
    }
    
    return parseSummary({});
  } catch (error) {
    console.error('Error fetching daily summary:', error);
    throw error;
  }
};

export const fetchGiftCardSummary = async (
  dateRange: DateRange = 'today',
  startDate?: Date,
  endDate?: Date
): Promise<GiftCardSummary> => {
  const queryString = buildQueryString(dateRange, startDate, endDate);
  const response = await apiRequest('GET', `/api/gift-card-summary?${queryString}`);
  if (response instanceof Response) {
    return await response.json();
  }
  return response as GiftCardSummary;
};

export const fetchDetailedTransactions = async (
  dateRange: DateRange = 'today',
  startDate?: Date,
  endDate?: Date
): Promise<DetailedTransactionBreakdown> => {
  try {
    const queryString = buildQueryString(dateRange, startDate, endDate);
    const response = await apiRequest('GET', `/api/detailed-transactions?${queryString}`);
    
    const parseFees = (f: unknown): ProcessingFeeBreakdown => {
      const obj = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      return {
        initialFees: toFloat(obj.initialFees),
        reimbursements: toFloat(obj.reimbursements),
        thirdPartyFees: toFloat(obj.thirdPartyFees),
        netFees: toFloat(obj.netFees),
      };
    };

    const parseGcBreakdown = (g: unknown): GcRedemptionBreakdown => {
      const obj = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
      return {
        bowlingDepositRedemptions: toFloat(obj.bowlingDepositRedemptions),
        laserTagDepositRedemptions: toFloat(obj.laserTagDepositRedemptions),
        giftCardRedemptions: toFloat(obj.giftCardRedemptions),
      };
    };

    const parseBreakdown = (d: Record<string, unknown>): DetailedTransactionBreakdown => ({
      partywirks: toFloat(d.partywirks),
      bowlingWebResDeposits: toFloat(d.bowlingWebResDeposits),
      laserTagWebResDeposits: toFloat(d.laserTagWebResDeposits),
      tripleseat: toFloat(d.tripleseat),
      tips: toFloat(d.tips),
      serviceCharges: toFloat(d.serviceCharges),
      autoGratuity: toFloat(d.autoGratuity),
      taxes: toFloat(d.taxes),
      refunds: toFloat(d.refunds),
      returns: toFloat(d.returns),
      discountsAndComps: toFloat(d.discountsAndComps),
      depositClearings: toFloat(d.depositClearings),
      giftCardSales: toFloat(d.giftCardSales),
      giftCardRedemptions: toFloat(d.giftCardRedemptions),
      gcRedemptionBreakdown: parseGcBreakdown(d.gcRedemptionBreakdown),
      processingFees: parseFees(d.processingFees),
      intercardRevenue: toFloat(d.intercardRevenue),
      totalTransactions: toInt(d.totalTransactions)
    });

    if (typeof response === 'object' && response !== null) {
      return parseBreakdown(response);
    }
    
    if (response instanceof Response) {
      const data = await response.json();
      return parseBreakdown(data);
    }
    
    return parseBreakdown({});
  } catch (error) {
    console.error('Error fetching detailed transactions:', error);
    throw error;
  }
};
