/**
 * Date & Time Utility Module
 * 
 * Provides consistent handling of dates and times throughout the application
 * with clear separation between storage (UTC) and display (Eastern Time)
 */
import { format, addDays, subDays, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { DateRange } from './schema';

// Timezone constants
export const EASTERN_TIMEZONE = 'America/New_York';
export const UTC_TIMEZONE = 'UTC';

// Define date range for queries
interface DateRangeBoundary {
  start: Date;  // Start datetime in UTC
  end: Date;    // End datetime in UTC
}

/**
 * Get UTC date range boundaries for a given date range specification
 * 
 * @param dateRange The type of date range (today, yesterday, etc.)
 * @param startDate Optional custom start date (for custom ranges)
 * @param endDate Optional custom end date (for custom ranges)
 * @returns Object containing start and end dates as UTC timestamps
 */
export function getDateRangeBoundaries(
  dateRange: DateRange,
  startDate?: Date,
  endDate?: Date
): DateRangeBoundary {
  // Always work with fresh Date objects to avoid mutation issues
  const now = new Date();
  
  // For custom date ranges, use the provided dates
  if (dateRange === 'custom' && startDate && endDate) {
    return {
      start: setUTCStartOfDay(startDate),
      end: setUTCEndOfDay(endDate)
    };
  }
  
  // Calculate standard date ranges in UTC
  let start: Date;
  let end: Date = setUTCEndOfDay(now); // Default end is end of today
  
  switch (dateRange) {
    case 'today':
      start = setUTCStartOfDay(now);
      break;
      
    case 'yesterday':
      start = setUTCStartOfDay(subDays(now, 1));
      end = setUTCEndOfDay(subDays(now, 1));
      break;
      
    case 'last7days':
      start = setUTCStartOfDay(subDays(now, 6));
      break;
      
    case 'last30days':
      start = setUTCStartOfDay(subDays(now, 29));
      break;
      
    case 'thisMonth':
      // First day of current month
      start = setUTCStartOfDay(startOfMonth(now));
      break;
      
    case 'lastMonth':
      // First day of previous month
      start = setUTCStartOfDay(startOfMonth(subMonths(now, 1)));
      // Last day of previous month
      end = setUTCEndOfDay(endOfMonth(subMonths(now, 1)));
      break;
      
    default:
      start = setUTCStartOfDay(now);
  }
  
  return { start, end };
}

/**
 * Set a date to the start of day (00:00:00.000) in UTC
 * Used for creating proper date range boundaries
 */
function setUTCStartOfDay(date: Date): Date {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

/**
 * Set a date to the end of day (23:59:59.999) in UTC
 * Used for creating proper date range boundaries
 */
function setUTCEndOfDay(date: Date): Date {
  const result = new Date(date);
  result.setUTCHours(23, 59, 59, 999);
  return result;
}

/**
 * Format a date for display in Eastern Time
 * Used only for UI presentation
 * 
 * @param date The date to format (in any timezone)
 * @param formatStr The format string to use
 * @returns Formatted date string in Eastern Time
 */
export function formatEasternDate(date: Date, formatStr: string = 'yyyy-MM-dd'): string {
  return formatInTimeZone(date, EASTERN_TIMEZONE, formatStr);
}

/**
 * Get the current date and time in Eastern Time
 * Used for display purposes
 */
export function getNowInEastern(): Date {
  return toZonedTime(new Date(), EASTERN_TIMEZONE);
}

/**
 * Format a date for SQL queries that need timezone conversion
 * Returns an ISO string that can be used in SQL statements
 */
export function toSqlTimestamp(date: Date): string {
  return date.toISOString();
}

/**
 * Get a descriptive string representing a date range
 * Used for UI display (e.g., "March 1 - March 7, 2025")
 */
export function getDateRangeLabel(
  dateRange: DateRange,
  startDate?: Date,
  endDate?: Date
): string {
  const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
  
  // Format dates in Eastern Time for display
  const startStr = formatEasternDate(start, 'MMM d, yyyy');
  const endStr = formatEasternDate(end, 'MMM d, yyyy');
  
  if (startStr === endStr) {
    return startStr;
  }
  
  return `${startStr} - ${endStr}`;
}

/**
 * Format an hour number (0-23) to a readable string (12am, 1pm, etc.)
 */
export function formatHour(hour: number): string {
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/**
 * Get a list of hourly slots for display in charts
 * Returns a list of formatted hour strings
 */
export function getHourlySlots(): string[] {
  return Array.from({ length: 24 }, (_, i) => formatHour(i));
}