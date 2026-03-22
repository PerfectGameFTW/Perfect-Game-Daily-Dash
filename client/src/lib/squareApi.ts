import { apiRequest } from "./queryClient";
import { DateRange, DailySummary, GiftCardSummary, DetailedTransactionBreakdown } from "@shared/schema";

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
    
    const parseSummary = (d: any): DailySummary => ({
      totalRevenue: typeof d.totalRevenue === 'number' ? d.totalRevenue : parseFloat(d.totalRevenue || '0'),
      grossPayments: typeof d.grossPayments === 'number' ? d.grossPayments : parseFloat(d.grossPayments || '0'),
      totalRefunds: typeof d.totalRefunds === 'number' ? d.totalRefunds : parseFloat(d.totalRefunds || '0'),
      giftCardRedemptions: typeof d.giftCardRedemptions === 'number' ? d.giftCardRedemptions : parseFloat(d.giftCardRedemptions || '0'),
      revenueChange: typeof d.revenueChange === 'number' ? d.revenueChange : parseFloat(d.revenueChange || '0'),
      totalOrders: typeof d.totalOrders === 'number' ? d.totalOrders : parseInt(d.totalOrders || '0', 10),
      ordersChange: typeof d.ordersChange === 'number' ? d.ordersChange : parseFloat(d.ordersChange || '0'),
      averageOrder: typeof d.averageOrder === 'number' ? d.averageOrder : parseFloat(d.averageOrder || '0'),
      averageOrderChange: typeof d.averageOrderChange === 'number' ? d.averageOrderChange : parseFloat(d.averageOrderChange || '0'),
      giftCardSales: typeof d.giftCardSales === 'number' ? d.giftCardSales : parseFloat(d.giftCardSales || '0'),
      giftCardSalesChange: typeof d.giftCardSalesChange === 'number' ? d.giftCardSalesChange : parseFloat(d.giftCardSalesChange || '0'),
      date: d.date || new Date().toISOString().split('T')[0]
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
    
    const parseBreakdown = (d: any): DetailedTransactionBreakdown => ({
      partywirks: typeof d.partywirks === 'number' ? d.partywirks : parseFloat(d.partywirks || '0'),
      bowlingWebResDeposits: typeof d.bowlingWebResDeposits === 'number' ? d.bowlingWebResDeposits : parseFloat(d.bowlingWebResDeposits || '0'),
      laserTagWebResDeposits: typeof d.laserTagWebResDeposits === 'number' ? d.laserTagWebResDeposits : parseFloat(d.laserTagWebResDeposits || '0'),
      tripleseat: typeof d.tripleseat === 'number' ? d.tripleseat : parseFloat(d.tripleseat || '0'),
      tips: typeof d.tips === 'number' ? d.tips : parseFloat(d.tips || '0'),
      serviceCharges: typeof d.serviceCharges === 'number' ? d.serviceCharges : parseFloat(d.serviceCharges || '0'),
      autoGratuity: typeof d.autoGratuity === 'number' ? d.autoGratuity : parseFloat(d.autoGratuity || '0'),
      taxes: typeof d.taxes === 'number' ? d.taxes : parseFloat(d.taxes || '0'),
      refunds: typeof d.refunds === 'number' ? d.refunds : parseFloat(d.refunds || '0'),
      returns: typeof d.returns === 'number' ? d.returns : parseFloat(d.returns || '0'),
      discountsAndComps: typeof d.discountsAndComps === 'number' ? d.discountsAndComps : parseFloat(d.discountsAndComps || '0'),
      depositClearings: typeof d.depositClearings === 'number' ? d.depositClearings : parseFloat(d.depositClearings || '0'),
      giftCardSales: typeof d.giftCardSales === 'number' ? d.giftCardSales : parseFloat(d.giftCardSales || '0'),
      giftCardRedemptions: typeof d.giftCardRedemptions === 'number' ? d.giftCardRedemptions : parseFloat(d.giftCardRedemptions || '0'),
      totalTransactions: typeof d.totalTransactions === 'number' ? d.totalTransactions : parseInt(d.totalTransactions || '0', 10)
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
