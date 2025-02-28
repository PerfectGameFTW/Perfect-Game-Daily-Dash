// Timezone utilities for proper business day alignment
import { format, addDays, subDays, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { DateRange } from '@shared/schema';

export const EASTERN_TIMEZONE = 'America/New_York';

/**
 * Converts a date to UTC for database storage
 */
export function toUTCStorage(date: Date): Date {
  return new Date(date.toUTCString());
}

/**
 * Gets a date range in UTC for database queries
 * This ensures consistent midnight-to-midnight business day boundaries
 */
export function getUTCDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): { start: Date; end: Date } {
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
  }

  // Create UTC dates that represent midnight Eastern Time for start/end days
  const startUTC = new Date(`${startDateStr}T00:00:00-05:00`);
  const endUTC = new Date(`${endDateStr}T23:59:59.999-05:00`);

  // Log the conversions for debugging
  console.log('Date range conversion:', {
    startDateStr,
    endDateStr,
    startUTC: startUTC.toISOString(),
    endUTC: endUTC.toISOString(),
    startET: formatInTimeZone(startUTC, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
    endET: formatInTimeZone(endUTC, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
  });

  return { start: startUTC, end: endUTC };
}

/**
 * Format a UTC date in Eastern Time for display
 */
export function formatInEasternTime(date: Date, formatStr: string = 'yyyy-MM-dd HH:mm:ss zzz'): string {
  return formatInTimeZone(date, EASTERN_TIMEZONE, formatStr);
}

/**
 * Convert a UTC date to Eastern Time for reporting
 */
export function toEasternTime(date: Date): Date {
  return toZonedTime(date, EASTERN_TIMEZONE);
}