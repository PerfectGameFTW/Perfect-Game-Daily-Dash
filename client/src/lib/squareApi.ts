import { apiRequest } from "./queryClient";
import { DateRange, DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary, Transaction } from "@shared/schema";

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
    const startDateString = startDate.toISOString().split('T')[0];
    queryParams += `&startDate=${startDateString}`;
    
    // If endDate is provided, use it; otherwise use startDate for single-day views
    const finalEndDate = endDate || startDate;
    const endDateString = finalEndDate.toISOString().split('T')[0];
    queryParams += `&endDate=${endDateString}`;
    
    console.log('API Request with dates:', {
      dateRange,
      startDate: startDateString,
      endDate: endDateString,
      queryParams
    });
  } else {
    console.log('API Request without custom dates:', {
      dateRange,
      queryParams
    });
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
