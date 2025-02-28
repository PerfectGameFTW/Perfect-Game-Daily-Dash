/**
 * Timezone utilities for proper business day alignment
 * All timestamps are stored in UTC (using timestamptz) and converted to Eastern Time for reporting
 * through dedicated database views (*_et).
 */
import { format, addDays, subDays, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { DateRange } from '@shared/schema';

/** Eastern Timezone identifier used throughout the application */
export const EASTERN_TIMEZONE = 'America/New_York';

/**
 * Converts a date to UTC for database storage
 * All timestamps should be stored in UTC using PostgreSQL's timestamptz type
 * 
 * @param date The date to convert to UTC
 * @returns A new Date object in UTC
 * 
 * @example
 * const timestamp = toUTCStorage(new Date()); // For storing in database
 */
export function toUTCStorage(date: Date): Date {
  console.log('Converting to UTC storage:', {
    input: date.toISOString(),
    output: new Date(date.toUTCString()).toISOString()
  });
  return new Date(date.toUTCString());
}

/**
 * Gets a date range in UTC for database queries
 * This ensures consistent midnight-to-midnight business day boundaries in Eastern Time
 * 
 * @param dateRange The type of date range to generate
 * @param startDate Optional start date for custom ranges
 * @param endDate Optional end date for custom ranges
 * @returns Object containing start and end dates in UTC
 * 
 * @example
 * const { start, end } = getUTCDateRange('today');
 * // start will be 00:00:00 ET in UTC
 * // end will be 23:59:59.999 ET in UTC
 */
export function getUTCDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): { start: Date; end: Date } {
  console.log('Processing date range request:', {
    dateRange,
    startDate: startDate?.toISOString(),
    endDate: endDate?.toISOString()
  });

  // Get the current date in Eastern Time for date range calculations
  const now = new Date();
  const easternNow = toZonedTime(now, EASTERN_TIMEZONE);
  const todayEasternStr = format(easternNow, 'yyyy-MM-dd');

  // Variables to store our date range strings
  let startDateStr: string;
  let endDateStr: string;

  // Determine date strings based on range type
  if (startDate && (dateRange === 'custom' || endDate)) {
    // Convert to Eastern Time to get the correct date (ignore time)
    const startInEastern = toZonedTime(startDate, EASTERN_TIMEZONE);
    const endInEastern = endDate ? toZonedTime(endDate, EASTERN_TIMEZONE) : startInEastern;

    // Extract just the date components (no time)
    startDateStr = format(startInEastern, 'yyyy-MM-dd');
    endDateStr = format(endInEastern, 'yyyy-MM-dd');

    console.log('Custom date range conversion:', {
      inputStart: startDate.toISOString(),
      inputEnd: endDate?.toISOString(),
      easternStart: startDateStr,
      easternEnd: endDateStr
    });
  } else {
    // For predefined ranges, calculate the dates in Eastern Time
    switch (dateRange) {
      case 'today':
        startDateStr = todayEasternStr;
        endDateStr = todayEasternStr;
        break;
      case 'yesterday':
        const yesterdayEastern = subDays(easternNow, 1);
        startDateStr = format(yesterdayEastern, 'yyyy-MM-dd');
        endDateStr = startDateStr;
        break;
      case 'last7days':
        startDateStr = format(subDays(easternNow, 6), 'yyyy-MM-dd');
        endDateStr = todayEasternStr;
        break;
      case 'last30days':
        startDateStr = format(subDays(easternNow, 29), 'yyyy-MM-dd');
        endDateStr = todayEasternStr;
        break;
      case 'thisMonth':
        const firstOfMonth = startOfMonth(easternNow);
        const lastOfMonth = endOfMonth(easternNow);
        startDateStr = format(firstOfMonth, 'yyyy-MM-dd');
        endDateStr = format(lastOfMonth, 'yyyy-MM-dd');
        break;
      case 'lastMonth':
        const lastMonthDate = subMonths(easternNow, 1);
        const firstOfLastMonth = startOfMonth(lastMonthDate);
        const lastOfLastMonth = endOfMonth(lastMonthDate);
        startDateStr = format(firstOfLastMonth, 'yyyy-MM-dd');
        endDateStr = format(lastOfLastMonth, 'yyyy-MM-dd');
        break;
      case 'custom':
        throw new Error('Start date and end date must be provided for custom date range');
      default:
        startDateStr = todayEasternStr;
        endDateStr = todayEasternStr;
    }

    console.log('Predefined date range conversion:', {
      range: dateRange,
      easternStart: startDateStr,
      easternEnd: endDateStr
    });
  }

  // Create UTC dates that represent midnight Eastern Time for start/end days
  const startUTC = new Date(`${startDateStr}T00:00:00-05:00`);
  const endUTC = new Date(`${endDateStr}T23:59:59.999-05:00`);

  console.log('Final date range:', {
    utcStart: startUTC.toISOString(),
    utcEnd: endUTC.toISOString(),
    easternStart: formatInTimeZone(startUTC, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
    easternEnd: formatInTimeZone(endUTC, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
  });

  return { start: startUTC, end: endUTC };
}

/**
 * Format a UTC date in Eastern Time for display
 * Use this for presenting timestamps to users in the application's timezone
 * 
 * @param date The UTC date to format
 * @param formatStr Optional format string (defaults to 'yyyy-MM-dd HH:mm:ss zzz')
 * @returns Formatted date string in Eastern Time
 * 
 * @example
 * const display = formatInEasternTime(order.createdAt);
 */
export function formatInEasternTime(date: Date, formatStr: string = 'yyyy-MM-dd HH:mm:ss zzz'): string {
  const formatted = formatInTimeZone(date, EASTERN_TIMEZONE, formatStr);
  console.log('Formatting timestamp:', {
    utcInput: date.toISOString(),
    easternOutput: formatted
  });
  return formatted;
}

/**
 * Convert a UTC date to Eastern Time for reporting
 * This is primarily used internally by the Eastern Time database views
 * 
 * @param date The UTC date to convert
 * @returns Date object representing the same instant in Eastern Time
 * 
 * @example
 * const easternDate = toEasternTime(transaction.timestamp);
 */
export function toEasternTime(date: Date): Date {
  const eastern = toZonedTime(date, EASTERN_TIMEZONE);
  console.log('Converting to Eastern Time:', {
    utcInput: date.toISOString(),
    easternOutput: eastern.toISOString()
  });
  return eastern;
}