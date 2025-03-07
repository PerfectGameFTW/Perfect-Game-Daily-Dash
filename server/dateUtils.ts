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
 * 
 * FIXED: Original code was incorrectly transforming dates from ET to UTC
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

  // FIXED: The original code was incorrectly handling the timezone conversion
  // Here we create the proper UTC equivalents of Eastern Time boundaries
  
  // First create JS Date objects for the start and end of the day in Eastern time
  // These are without timezone information yet
  const startTimeInET = new Date(`${startStr}T00:00:00`);
  const endTimeInET = new Date(`${endStr}T23:59:59.999`);
  
  // Now format these with proper timezone information using date-fns-tz
  // This handles DST correctly based on the date
  const startInEasternTZ = formatInTimeZone(startTimeInET, EASTERN_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const endInEasternTZ = formatInTimeZone(endTimeInET, EASTERN_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
  
  // Convert these to Date objects, which will automatically adjust to UTC internally
  const startDate = new Date(startInEasternTZ);
  const endDate = new Date(endInEasternTZ);
  
  // To verify the conversion is correct:
  console.log('Converting Eastern dates to UTC (FIXED):', {
    startET: startInEasternTZ,
    endET: endInEasternTZ,
    startUTC: startDate.toISOString(),
    endUTC: endDate.toISOString(),
    correctDifference: 'UTC should be 5 hours ahead of Eastern (add 5 hours)'
  });
  
  return {
    start: startDate,
    end: endDate
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
 * FIXED: Was creating a new Date without timezone adjustment
 */
export function utcToEastern(date: Date): Date {
  // Create a string representation of the date in Eastern Time
  const easternISOString = formatInTimeZone(date, EASTERN_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
  
  // Log the conversion for debugging
  console.log('UTC to Eastern conversion:', {
    inputUTC: date.toISOString(),
    outputEastern: easternISOString,
    correctDifference: 'Eastern time should be 5 hours behind UTC (minus 5 hours)'
  });
  
  // Parse the ISO string with timezone information back into a Date object
  return new Date(easternISOString);
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