/**
 * Timezone utilities for proper business day alignment
 * All timestamps are stored in UTC (using timestamptz) and converted to Eastern Time for reporting
 * through dedicated database views (*_et).
 */
import { format, addDays, subDays, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { DateRange } from '@shared/schema';

/** Eastern Timezone identifier used throughout the application */
export const EASTERN_TIMEZONE = 'America/New_York';

/**
 * Gets the start and end dates in Eastern Time for any given date range
 * Ensures consistent midnight-to-midnight business day boundaries in Eastern Time
 */
export function getEasternDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): { start: Date; end: Date } {
  // Get current time in Eastern timezone
  const now = new Date();
  const startStr: string;
  const endStr: string;

  // Calculate date range boundaries in ET
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
        const yesterdayStr = formatInTimeZone(yesterday, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        startStr = yesterdayStr;
        endStr = yesterdayStr;
        break;
      }
      case 'last7days': {
        const sevenDaysAgo = subDays(now, 6); // Last 7 days including today
        startStr = formatInTimeZone(sevenDaysAgo, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        endStr = today;
        break;
      }
      case 'last30days': {
        const thirtyDaysAgo = subDays(now, 29); // Last 30 days including today
        startStr = formatInTimeZone(thirtyDaysAgo, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        endStr = today;
        break;
      }
      case 'thisMonth': {
        const firstOfMonth = startOfMonth(now);
        const lastOfMonth = endOfMonth(now);
        startStr = formatInTimeZone(firstOfMonth, EASTERN_TIMEZONE, 'yyyy-MM-dd');
        endStr = formatInTimeZone(lastOfMonth, EASTERN_TIMEZONE, 'yyyy-MM-dd');
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

  return {
    start: new Date(`${startStr}T00:00:00`),
    end: new Date(`${endStr}T23:59:59.999`)
  };
}

/**
 * Format hour number to AM/PM string
 */
export function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

/**
 * Format a date string in Eastern Time
 */
export function formatEasternDate(date: Date): string {
  return formatInTimeZone(date, EASTERN_TIMEZONE, 'yyyy-MM-dd');
}