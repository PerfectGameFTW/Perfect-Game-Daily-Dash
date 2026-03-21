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
      
      // Ensure all numeric fields are actually numbers (not strings)
      const processedResponse = {
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
      
      console.log('⭐ Processed daily summary data:', processedResponse);
      return processedResponse;
    }
    
    // If it's a Response object, parse it
    if (response instanceof Response) {
      console.log('⭐ Daily summary API returned Response object, parsing JSON...');
      const data = await response.json();
      console.log('⭐ Parsed JSON response:', data);
      
      // Process the data to ensure all numeric fields are actually numbers
      const processedData = {
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
      
      console.log('⭐ Processed JSON data:', processedData);
      return processedData;
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
      
      // Process the data to ensure all numeric fields are actually numbers
      const processedResponse = {
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
      
      console.log('⭐ Processed detailed transactions data:', processedResponse);
      return processedResponse;
    }
    
    // If it's a Response object, parse it
    if (response instanceof Response) {
      console.log('⭐ Detailed transactions API returned Response object, parsing JSON...');
      const data = await response.json();
      console.log('⭐ Parsed JSON response:', data);
      
      // Process the data to ensure all numeric fields are actually numbers
      const processedData = {
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
      
      console.log('⭐ Processed detailed transactions JSON data:', processedData);
      return processedData;
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
      giftCardSales: 0,
      totalTransactions: 0
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
