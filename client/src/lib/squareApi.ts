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
    
    if (typeof response === 'object' && response !== null) {
      return {
        totalRevenue: typeof response.totalRevenue === 'number' ? response.totalRevenue : parseFloat(response.totalRevenue || '0'),
        revenueChange: typeof response.revenueChange === 'number' ? response.revenueChange : parseFloat(response.revenueChange || '0'),
        totalOrders: typeof response.totalOrders === 'number' ? response.totalOrders : parseInt(response.totalOrders || '0', 10),
        ordersChange: typeof response.ordersChange === 'number' ? response.ordersChange : parseFloat(response.ordersChange || '0'),
        averageOrder: typeof response.averageOrder === 'number' ? response.averageOrder : parseFloat(response.averageOrder || '0'),
        averageOrderChange: typeof response.averageOrderChange === 'number' ? response.averageOrderChange : parseFloat(response.averageOrderChange || '0'),
        giftCardSales: typeof response.giftCardSales === 'number' ? response.giftCardSales : parseFloat(response.giftCardSales || '0'),
        giftCardSalesChange: typeof response.giftCardSalesChange === 'number' ? response.giftCardSalesChange : parseFloat(response.giftCardSalesChange || '0'),
        date: response.date || new Date().toISOString().split('T')[0]
      };
    }
    
    if (response instanceof Response) {
      const data = await response.json();
      return {
        totalRevenue: typeof data.totalRevenue === 'number' ? data.totalRevenue : parseFloat(data.totalRevenue || '0'),
        revenueChange: typeof data.revenueChange === 'number' ? data.revenueChange : parseFloat(data.revenueChange || '0'),
        totalOrders: typeof data.totalOrders === 'number' ? data.totalOrders : parseInt(data.totalOrders || '0', 10),
        ordersChange: typeof data.ordersChange === 'number' ? data.ordersChange : parseFloat(data.ordersChange || '0'),
        averageOrder: typeof data.averageOrder === 'number' ? data.averageOrder : parseFloat(data.averageOrder || '0'),
        averageOrderChange: typeof data.averageOrderChange === 'number' ? data.averageOrderChange : parseFloat(data.averageOrderChange || '0'),
        giftCardSales: typeof data.giftCardSales === 'number' ? data.giftCardSales : parseFloat(data.giftCardSales || '0'),
        giftCardSalesChange: typeof data.giftCardSalesChange === 'number' ? data.giftCardSalesChange : parseFloat(data.giftCardSalesChange || '0'),
        date: data.date || new Date().toISOString().split('T')[0]
      };
    }
    
    return {
      totalRevenue: 0, revenueChange: 0, totalOrders: 0, ordersChange: 0,
      averageOrder: 0, averageOrderChange: 0, giftCardSales: 0, giftCardSalesChange: 0,
      date: new Date().toISOString().split('T')[0]
    };
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
  return await response.json();
};

export const fetchDetailedTransactions = async (
  dateRange: DateRange = 'today',
  startDate?: Date,
  endDate?: Date
): Promise<DetailedTransactionBreakdown> => {
  try {
    const queryString = buildQueryString(dateRange, startDate, endDate);
    const response = await apiRequest('GET', `/api/detailed-transactions?${queryString}`);
    
    if (typeof response === 'object' && response !== null) {
      return {
        partywirks: typeof response.partywirks === 'number' ? response.partywirks : parseFloat(response.partywirks || '0'),
        tripleseat: typeof response.tripleseat === 'number' ? response.tripleseat : parseFloat(response.tripleseat || '0'),
        tips: typeof response.tips === 'number' ? response.tips : parseFloat(response.tips || '0'),
        serviceCharges: typeof response.serviceCharges === 'number' ? response.serviceCharges : parseFloat(response.serviceCharges || '0'),
        taxes: typeof response.taxes === 'number' ? response.taxes : parseFloat(response.taxes || '0'),
        refunds: typeof response.refunds === 'number' ? response.refunds : parseFloat(response.refunds || '0'),
        discountsAndComps: typeof response.discountsAndComps === 'number' ? response.discountsAndComps : parseFloat(response.discountsAndComps || '0'),
        giftCardSales: typeof response.giftCardSales === 'number' ? response.giftCardSales : parseFloat(response.giftCardSales || '0'),
        totalTransactions: typeof response.totalTransactions === 'number' ? response.totalTransactions : parseInt(response.totalTransactions || '0', 10)
      };
    }
    
    if (response instanceof Response) {
      const data = await response.json();
      return {
        partywirks: typeof data.partywirks === 'number' ? data.partywirks : parseFloat(data.partywirks || '0'),
        tripleseat: typeof data.tripleseat === 'number' ? data.tripleseat : parseFloat(data.tripleseat || '0'),
        tips: typeof data.tips === 'number' ? data.tips : parseFloat(data.tips || '0'),
        serviceCharges: typeof data.serviceCharges === 'number' ? data.serviceCharges : parseFloat(data.serviceCharges || '0'),
        taxes: typeof data.taxes === 'number' ? data.taxes : parseFloat(data.taxes || '0'),
        refunds: typeof data.refunds === 'number' ? data.refunds : parseFloat(data.refunds || '0'),
        discountsAndComps: typeof data.discountsAndComps === 'number' ? data.discountsAndComps : parseFloat(data.discountsAndComps || '0'),
        giftCardSales: typeof data.giftCardSales === 'number' ? data.giftCardSales : parseFloat(data.giftCardSales || '0'),
        totalTransactions: typeof data.totalTransactions === 'number' ? data.totalTransactions : parseInt(data.totalTransactions || '0', 10)
      };
    }
    
    return {
      partywirks: 0, tripleseat: 0, tips: 0, serviceCharges: 0,
      taxes: 0, refunds: 0, discountsAndComps: 0, giftCardSales: 0, totalTransactions: 0
    };
  } catch (error) {
    console.error('Error fetching detailed transactions:', error);
    throw error;
  }
};
