import { apiRequest } from "./queryClient";
import { DateRange, DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary, Transaction, DetailedTransactionBreakdown } from "@shared/schema";

// Helper to build query string
const buildQueryString = (
  dateRange: DateRange, 
  startDate?: Date, 
  endDate?: Date
): string => {
  let queryParams = `dateRange=${dateRange}`;
  
  // Always add date parameters if they exist, regardless of the named dateRange
  // This allows us to show specific days when using arrows
  if (startDate) {
    // CRITICAL FIX: We need to preserve the exact UTC time because
    // the server needs to convert this UTC time to Eastern business hours properly
    const startDateISO = startDate.toISOString();
    queryParams += `&startDate=${encodeURIComponent(startDateISO)}`;
    
    // If endDate is provided, use it; otherwise use startDate for single-day views
    const finalEndDate = endDate || startDate;
    const endDateISO = finalEndDate.toISOString();
    queryParams += `&endDate=${encodeURIComponent(endDateISO)}`;
    
    console.log('API Request with custom dates (FIXED ISO FORMAT):', {
      dateRange,
      startDateISO,
      endDateISO,
      queryParams
    });
  } else {
    console.log('API Request without custom dates:', {
      dateRange,
      queryParams
    });
    // All date ranges are handled the same way - no special case handling
  }
  
  return queryParams;
};

// API functions for dashboard data
export const fetchDailySummary = async (
  dateRange: DateRange = 'today',
  startDate?: Date,
  endDate?: Date
): Promise<DailySummary> => {
  try {
    const queryString = buildQueryString(dateRange, startDate, endDate);
    console.log('⭐ Fetching daily summary with query:', `/api/summary?${queryString}`);
    const response = await apiRequest('GET', `/api/summary?${queryString}`);
    
    // Check if response is already JSON
    if (typeof response === 'object' && response !== null) {
      console.log('⭐ Daily summary API returned JSON object directly:', response);
      return response;
    }
    
    // If it's a Response object, parse it
    if (response instanceof Response) {
      console.log('⭐ Daily summary API returned Response object, parsing JSON...');
      const data = await response.json();
      console.log('⭐ Parsed JSON response:', data);
      return data;
    }
    
    // Fallback case, should not happen with our API setup
    console.error('⭐ Unexpected response type from daily summary API:', typeof response);
    return {
      totalRevenue: 0,
      revenueChange: 0,
      totalOrders: 0,
      ordersChange: 0,
      averageOrder: 0,
      averageOrderChange: 0,
      giftCardSales: 0,
      giftCardSalesChange: 0,
      date: new Date().toISOString().split('T')[0]
    };
  } catch (error) {
    console.error('⭐ Error fetching daily summary:', error);
    throw error;
  }
};

export const fetchTransactions = async (
  dateRange: DateRange = 'today',
  startDate?: Date,
  endDate?: Date
): Promise<Transaction[]> => {
  const queryString = buildQueryString(dateRange, startDate, endDate);
  const response = await apiRequest('GET', `/api/transactions?${queryString}`);
  return await response.json();
};

export const fetchCategoryRevenue = async (
  dateRange: DateRange = 'today',
  startDate?: Date,
  endDate?: Date
): Promise<CategoryRevenue[]> => {
  const queryString = buildQueryString(dateRange, startDate, endDate);
  const response = await apiRequest('GET', `/api/revenue-by-category?${queryString}`);
  return await response.json();
};

export const fetchHourlyRevenue = async (
  dateRange: DateRange = 'today',
  startDate?: Date,
  endDate?: Date
): Promise<HourlyRevenue[]> => {
  const queryString = buildQueryString(dateRange, startDate, endDate);
  const response = await apiRequest('GET', `/api/hourly-revenue?${queryString}`);
  return await response.json();
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
    console.log('⭐ Fetching detailed transactions with query:', `/api/detailed-transactions?${queryString}`);
    const response = await apiRequest('GET', `/api/detailed-transactions?${queryString}`);
    
    // Check if response is already JSON
    if (typeof response === 'object' && response !== null) {
      console.log('⭐ Detailed transactions API returned JSON object directly:', response);
      return response;
    }
    
    // If it's a Response object, parse it
    if (response instanceof Response) {
      console.log('⭐ Detailed transactions API returned Response object, parsing JSON...');
      const data = await response.json();
      console.log('⭐ Parsed JSON response:', data);
      return data;
    }
    
    // Fallback case
    console.error('⭐ Unexpected response type from detailed transactions API:', typeof response);
    return {
      partywirks: 0,
      tripleseat: 0,
      tips: 0,
      serviceCharges: 0,
      taxes: 0,
      refunds: 0,
      discountsAndComps: 0,
      giftCardSales: 0
    };
  } catch (error) {
    console.error('⭐ Error fetching detailed transactions:', error);
    throw error;
  }
};

// Test gift card detection endpoint removed as part of unifying sync process
// All gift card transactions are now identified through the standard sync process

// Get the current sync status
// Sync status endpoint has been removed
