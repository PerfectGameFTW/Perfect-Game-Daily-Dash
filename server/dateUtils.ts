/**
 * Timezone utilities for proper business day alignment
 * 
 * Updated architecture:
 * - All timestamps are stored in UTC (using timestamptz) in the database
 * - All database queries use direct UTC timestamps (no timezone conversion)
 * - Frontend displays dates in user's local timezone (Eastern) for consistency
 */
import { format, addDays, subDays, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { DateRange } from '@shared/schema';

/** Eastern Timezone identifier used throughout the application */
export const EASTERN_TIMEZONE = 'America/New_York';

/**
 * Gets the start and end dates in UTC for any given date range
 * These dates represent business day boundaries in Eastern Time but are returned as UTC timestamps
 * for direct database queries without timezone conversions.
 */
export function getEasternDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): { start: Date; end: Date } {
  const now = new Date();
  let startStr: string;
  let endStr: string;

  // Calculate date range boundaries in ET (for display)
  if (startDate && endDate && dateRange === 'custom') {
    startStr = formatInTimeZone(startDate, EASTERN_TIMEZONE, 'yyyy-MM-dd');
    endStr = formatInTimeZone(endDate, EASTERN_TIMEZONE, 'yyyy-MM-dd');
  } else {
    const today = formatInTimeZone(now, EASTERN_TIMEZONE, 'yyyy-MM-dd');

    switch (dateRange) {
      case 'today':
        startStr = today;
        endStr = today;
        break;
      case 'yesterday': {
        const yesterday = subDays(now, 1);
        startStr = formatInTimeZone(yesterday, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        endStr = startStr;
        break;
      }
      case 'last7days': {
        const sevenDaysAgo = subDays(now, 6);
        startStr = formatInTimeZone(sevenDaysAgo, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        endStr = today;
        break;
      }
      case 'last30days': {
        const thirtyDaysAgo = subDays(now, 29);
        startStr = formatInTimeZone(thirtyDaysAgo, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        endStr = today;
        break;
      }
      case 'thisMonth': {
        const firstOfMonth = startOfMonth(now);
        startStr = formatInTimeZone(firstOfMonth, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        endStr = formatInTimeZone(now, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        break;
      }
      case 'lastMonth': {
        const lastMonth = subMonths(now, 1);
        const firstOfLastMonth = startOfMonth(lastMonth);
        const lastOfLastMonth = endOfMonth(lastMonth);
        startStr = formatInTimeZone(firstOfLastMonth, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        endStr = formatInTimeZone(lastOfLastMonth, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        break;
      }
      default:
        startStr = today;
        endStr = today;
    }
  }

  console.log('Date range calculation:', {
    range: dateRange,
    input: {
      startDate: startDate?.toISOString(),
      endDate: endDate?.toISOString()
    },
    calculated: {
      startStr,
      endStr,
      timezone: EASTERN_TIMEZONE
    }
  });

  // Return UTC dates that correspond to the ET date boundaries
  // This ensures we're using consistent UTC timestamps in all database queries
  // These timestamps represent midnight and 11:59:59.999 PM in Eastern Time
  // but are stored as UTC values for direct database comparison
  return {
    start: new Date(`${startStr}T00:00:00-05:00`), // Beginning of ET day in UTC
    end: new Date(`${endStr}T23:59:59.999-05:00`)  // End of ET day in UTC
  };
}

/**
 * Format a date string in Eastern Time for display purposes
 * Not used for database queries, only for UI formatting
 */
export function formatEasternDate(date: Date): string {
  return formatInTimeZone(date, EASTERN_TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Convert a UTC date to Eastern Time equivalent
 * Used only for display purposes, not for database queries
 */
export function utcToEastern(date: Date): Date {
  const easternDateStr = formatInTimeZone(date, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  return new Date(easternDateStr);
}

/**
 * Format hour number to AM/PM string
 * Used for UI display only
 */
export function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}