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

// Test gift card detection endpoint removed as part of unifying sync process
// All gift card transactions are now identified through the standard sync process

// Get the current sync status
// Sync status endpoint has been removed
