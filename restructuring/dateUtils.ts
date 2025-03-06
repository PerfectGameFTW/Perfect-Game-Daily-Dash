/**
 * Date & Time Utility Module
 * 
 * Provides consistent handling of dates and times throughout the application
 * with clear separation between storage (UTC) and display (Eastern Time)
 */
import { format, utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import { startOfDay, endOfDay, subDays, addDays, isSameDay } from 'date-fns';
import { DateRange } from './schema';

// Constants
export const EASTERN_TIMEZONE = 'America/New_York';
export const UTC_TIMEZONE = 'UTC';

// Define the shape of date range boundaries
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
  // For consistent results, start with a UTC date representation
  const now = new Date();
  
  let start: Date;
  let end: Date = setUTCEndOfDay(now); // Default end is end of today
  
  // For custom date range, use the provided dates
  if (dateRange === 'custom' && startDate && endDate) {
    // Ensure dates are interpreted as UTC
    start = setUTCStartOfDay(new Date(startDate));
    end = setUTCEndOfDay(new Date(endDate));
  } 
  // Handle predefined date ranges
  else {
    switch (dateRange) {
      case 'today':
        start = setUTCStartOfDay(now);
        end = setUTCEndOfDay(now);
        break;
        
      case 'yesterday':
        const yesterday = subDays(now, 1);
        start = setUTCStartOfDay(yesterday);
        end = setUTCEndOfDay(yesterday);
        break;
        
      case 'this_week':
        // Start from Sunday or Monday of current week
        const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
        const daysFromStartOfWeek = dayOfWeek === 0 ? 0 : dayOfWeek;
        start = setUTCStartOfDay(subDays(now, daysFromStartOfWeek));
        break;
        
      case 'last_week':
        // Last week (previous Sunday to Saturday)
        const daysFromLastSunday = now.getUTCDay() === 0 
          ? 7 // If today is Sunday, go back to last Sunday
          : now.getUTCDay() + 7;
        start = setUTCStartOfDay(subDays(now, daysFromLastSunday));
        end = setUTCEndOfDay(addDays(start, 6)); // End on Saturday
        break;
        
      case 'this_month':
        // Start from 1st of current month
        start = setUTCStartOfDay(new Date(Date.UTC(
          now.getUTCFullYear(), 
          now.getUTCMonth(), 
          1
        )));
        break;
        
      case 'last_month':
        // Last month (1st to last day of previous month)
        start = setUTCStartOfDay(new Date(Date.UTC(
          now.getUTCFullYear(), 
          now.getUTCMonth() - 1, 
          1
        )));
        
        // End of last month = day before 1st of current month
        end = setUTCEndOfDay(new Date(Date.UTC(
          now.getUTCFullYear(), 
          now.getUTCMonth(), 
          0
        )));
        break;
        
      case 'last_30_days':
        start = setUTCStartOfDay(subDays(now, 30));
        break;
        
      case 'last_90_days':
        start = setUTCStartOfDay(subDays(now, 90));
        break;
        
      default:
        // Default to today
        start = setUTCStartOfDay(now);
        end = setUTCEndOfDay(now);
    }
  }
  
  // Log for debugging
  console.log(`Date range calculation:`, {
    range: dateRange,
    input: { startDate, endDate },
    calculated: {
      startStr: start.toISOString().split('T')[0],
      endStr: end.toISOString().split('T')[0],
      timezone: 'UTC'
    }
  });
  
  return { start, end };
}

/**
 * Set a date to the start of day (00:00:00.000) in UTC
 * Used for creating proper date range boundaries
 */
function setUTCStartOfDay(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0
  ));
}

/**
 * Set a date to the end of day (23:59:59.999) in UTC
 * Used for creating proper date range boundaries
 */
function setUTCEndOfDay(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    23, 59, 59, 999
  ));
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
  // Convert date to Eastern Time
  const easternDate = utcToZonedTime(date, EASTERN_TIMEZONE);
  
  // Format the date in Eastern Time
  return format(easternDate, formatStr, { timeZone: EASTERN_TIMEZONE });
}

/**
 * Get the current date and time in Eastern Time
 * Used for display purposes
 */
export function getNowInEastern(): Date {
  return utcToZonedTime(new Date(), EASTERN_TIMEZONE);
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
  
  // For single-day ranges, just show one date
  if (isSameDay(start, end)) {
    return formatEasternDate(start, 'MMMM d, yyyy');
  }
  
  // For multi-day ranges, show start and end dates
  const startMonth = formatEasternDate(start, 'MMMM');
  const endMonth = formatEasternDate(end, 'MMMM');
  const startDay = formatEasternDate(start, 'd');
  const endDay = formatEasternDate(end, 'd');
  const year = formatEasternDate(end, 'yyyy');
  
  // If same month, don't repeat month name
  if (startMonth === endMonth) {
    return `${startMonth} ${startDay} - ${endDay}, ${year}`;
  }
  
  // Different months
  return `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${year}`;
}

/**
 * Format an hour number (0-23) to a readable string (12am, 1pm, etc.)
 */
export function formatHour(hour: number): string {
  const h = hour % 12 || 12; // Convert 0 to 12 for 12am
  const ampm = hour < 12 ? 'am' : 'pm';
  return `${h}${ampm}`;
}

/**
 * Get a list of hourly slots for display in charts
 * Returns a list of formatted hour strings
 */
export function getHourlySlots(): string[] {
  return Array.from({ length: 24 }, (_, i) => formatHour(i));
}