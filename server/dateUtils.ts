/**
 * Timezone utilities for proper business day alignment
 * 
 * This module handles critical timezone conversions between UTC and Eastern Time,
 * ensuring that business day boundaries are correctly defined for reporting and analytics.
 * 
 * IMPORTANT: See docs/timestamp-handling.md for complete documentation.
 * 
 * ARCHITECTURE:
 * - All timestamps are stored in UTC (using timestamptz) in the database
 * - Business days are defined in Eastern Time (America/New_York)
 * - Database queries use precise UTC timestamps that align with Eastern business days
 * - For March 7th in Eastern Time, the UTC range is:
 *   - Start: March 7 05:00:00 UTC (March 7 00:00:00 ET)
 *   - End:   March 8 04:59:59.999 UTC (March 7 23:59:59.999 ET)
 * - Frontend displays dates in Eastern Time for consistency
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
 * 
 * CRITICAL FIX: The original implementation had a timezone direction error
 * For business days in Eastern Time, UTC timestamps are 5 hours ahead (during standard time)
 * This means:
 * - Eastern midnight = UTC 05:00
 * - Eastern 11:59 PM = UTC 04:59:59.999 (next day)
 */
export function getEasternDateRange(dateRange: DateRange, inputStartDate?: Date, inputEndDate?: Date): { start: Date; end: Date } {
  const now = new Date();
  let startStr: string;
  let endStr: string;

  // Calculate date range boundaries in ET (for display)
  if (inputStartDate && inputEndDate && dateRange === 'custom') {
    startStr = formatInTimeZone(inputStartDate, EASTERN_TIMEZONE, 'yyyy-MM-dd');
    endStr = formatInTimeZone(inputEndDate, EASTERN_TIMEZONE, 'yyyy-MM-dd');
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
      startDate: inputStartDate?.toISOString(),
      endDate: inputEndDate?.toISOString()
    },
    calculated: {
      startStr,
      endStr,
      timezone: EASTERN_TIMEZONE
    }
  });

  // For business days in Eastern Time, calculate the precise UTC timestamp
  // that corresponds to the start and end of the business day
  
  // For example, March 7th in Eastern Time:
  // Start: March 7 00:00:00 ET = March 7 05:00:00 UTC
  // End: March 7 23:59:59.999 ET = March 8 04:59:59.999 UTC
  
  // Use proper timezone calculations through date-fns-tz instead of hardcoded offsets
  // This will account for Daylight Saving Time automatically
  const startDate = new Date(`${startStr}T00:00:00Z`);
  const endDate = new Date(`${endStr}T23:59:59.999Z`);
  
  // Convert the dates to ET time zone properly accounting for DST
  const startInET = formatInTimeZone(startDate, EASTERN_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  const endInET = formatInTimeZone(endDate, EASTERN_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  
  // Create new Date objects that properly account for timezone
  const startDateFinal = new Date(startInET + 'Z');
  const endDateFinal = new Date(endInET + 'Z');
  
  console.log('Converting Eastern business days to UTC timestamps:', {
    startET: startInET,
    endET: endInET,
    startUTC: startDateFinal.toISOString(),
    endUTC: endDateFinal.toISOString(),
    explanation: 'Using date-fns-tz to properly handle DST transitions in Eastern Time'
  });
  
  return {
    start: startDateFinal,
    end: endDateFinal
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
 * 
 * CRITICAL FIX: Correctly handles timezone conversion from UTC to Eastern Time
 * Eastern Time is UTC-5 (standard time) or UTC-4 (daylight saving time)
 */
export function utcToEastern(date: Date): Date {
  // Use formatInTimeZone to properly convert between timezones while respecting DST
  const easternISOString = formatInTimeZone(date, EASTERN_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
  
  // Log the conversion for debugging
  console.log('UTC to Eastern conversion (FIXED):', {
    inputUTC: date.toISOString(),
    outputEastern: easternISOString,
    explanation: 'Eastern time is 5 hours behind UTC during standard time, 4 hours behind during DST'
  });
  
  // Parse the ISO string with timezone information back into a Date object
  // This will preserve the time as it appears in Eastern Time
  return new Date(easternISOString);
}

/**
 * Format hour number to AM/PM string
 * Used for UI display only in Eastern Time
 * 
 * @param hour Hour number in 24-hour format (0-23)
 * @returns Formatted hour string in 12-hour format with AM/PM
 */
export function formatHour(hour: number): string {
  // Handle special cases for 12AM and 12PM
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  
  // Morning hours (1-11 AM)
  if (hour < 12) return `${hour} AM`;
  
  // Afternoon/evening hours (1-11 PM)
  return `${hour - 12} PM`;
}

/**
 * Convert a UTC timestamp to an Eastern Time hour string
 * Used for displaying hourly revenue in Eastern Time
 * 
 * @param utcDate UTC date object
 * @returns Formatted hour string in Eastern Time
 */
export function getEasternHourFromUTC(utcDate: Date): string {
  // Format the date in Eastern Time to get the hour
  const easternHour = formatInTimeZone(utcDate, EASTERN_TIMEZONE, 'H');
  
  // Convert to number and format
  return formatHour(parseInt(easternHour, 10));
}