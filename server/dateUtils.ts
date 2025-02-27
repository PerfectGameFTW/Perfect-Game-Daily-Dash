// Simple Eastern Time Date Utility
// Handles date conversions for proper business day alignment in Eastern Time

import { format, addDays, subDays, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { DateRange } from '@shared/schema';

export const EASTERN_TIMEZONE = 'America/New_York';

/**
 * Converts a date range in Eastern Time to UTC date range for database queries
 * This ensures consistent midnight-to-midnight business day boundaries
 */
export function getEasternDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): { start: Date; end: Date } {
  console.log('DIAGNOSTIC - Processing date range request:', { dateRange, startDate, endDate });
  
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
    
    console.log('Custom date range in Eastern Time:', { startDateStr, endDateStr });
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
        endDateStr = startDateStr; // Same day range
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
        // Default to today
        startDateStr = todayEasternStr;
        endDateStr = todayEasternStr;
    }
  }
  
  // Create date objects in Eastern Time that represent midnight of start day
  // and 11:59:59.999 PM of end day
  
  // First, create ISO string representations with the Eastern timezone offset
  // This approach explicitly sets the timezone offset for the specific dates
  const tzString = formatInTimeZone(new Date(), EASTERN_TIMEZONE, 'xxx');
  console.log(`Using timezone ${tzString} for dates ${startDateStr} to ${endDateStr}`);
  
  // Create the full ISO strings with the correct timezone offset
  const startISOString = `${startDateStr}T00:00:00.000${tzString}`;
  const endISOString = `${endDateStr}T23:59:59.999${tzString}`;
  
  // Parse these strings into Date objects, which will automatically convert to UTC
  const startUTC = new Date(startISOString);
  const endUTC = new Date(endISOString);
  
  // Log the exact conversions for debugging
  console.log(`Eastern midnight to 11:59:59.999 PM converted to UTC:`, {
    easternStartStr: formatInTimeZone(startUTC, EASTERN_TIMEZONE, 'yyyy-MM-dd\'T\'HH:mm:ss.SSS zzz'),
    easternEndStr: formatInTimeZone(endUTC, EASTERN_TIMEZONE, 'yyyy-MM-dd\'T\'HH:mm:ss.SSS zzz'),
    utcStartStr: startUTC.toISOString(),
    utcEndStr: endUTC.toISOString()
  });
  
  console.log('FINAL DATABASE QUERY RANGE:', {
    utcStart: startUTC.toISOString(),
    utcEnd: endUTC.toISOString(),
    easternStart: formatInTimeZone(startUTC, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
    easternEnd: formatInTimeZone(endUTC, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
  });
  
  return { start: startUTC, end: endUTC };
}