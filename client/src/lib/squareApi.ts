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
    // Ensure we're working with a clean date copy
    const startDateObj = new Date(startDate);
    // Format to YYYY-MM-DD to avoid timezone issues
    const startDateString = startDateObj.toISOString().split('T')[0];
    queryParams += `&startDate=${startDateString}`;
    
    // If endDate is provided, use it; otherwise use startDate for single-day views
    const finalEndDate = endDate || startDate;
    const endDateObj = new Date(finalEndDate);
    const endDateString = endDateObj.toISOString().split('T')[0];
    queryParams += `&endDate=${endDateString}`;
    
    console.log('API Request with custom dates:', {
      dateRange,
      startDateObj: startDateObj.toISOString(),
      endDateObj: endDateObj.toISOString(),
      startDate: startDateString,
      endDate: endDateString,
      queryParams
    });
  } else {
    console.log('API Request without custom dates:', {
      dateRange,
      queryParams
    });
    
    // Special handling for predefined date ranges
    if (dateRange === 'yesterday') {
      console.log('🔍 Using predefined YESTERDAY date range with no custom dates');
    } else if (dateRange === 'today') {
      console.log('🔍 Using predefined TODAY date range with no custom dates');
    }
  }
  
  return queryParams;
};

// API functions for dashboard data
export const fetchDailySummary = async (
  dateRange: DateRange = 'today',
  startDate?: Date,
  endDate?: Date
): Promise<DailySummary> => {
  const queryString = buildQueryString(dateRange, startDate, endDate);
  const response = await apiRequest('GET', `/api/summary?${queryString}`);
  return await response.json();
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
  const queryString = buildQueryString(dateRange, startDate, endDate);
  const response = await apiRequest('GET', `/api/detailed-transactions?${queryString}`);
  return await response.json();
};

// Function to test gift card detection for Feb 25 transactions
export const testGiftCardDetection = async (): Promise<any> => {
  const response = await apiRequest('GET', `/api/test-gift-card-detection`);
  return await response.json();
};

// Get the current sync status
// Sync status endpoint has been removed
