// New Eastern Time Date Utility
// This file handles all date conversions for proper business day alignment

const { format, addDays, subDays, startOfMonth, endOfMonth, subMonths } = require('date-fns');
const { formatInTimeZone, toZonedTime } = require('date-fns-tz');

const EASTERN_TIMEZONE = 'America/New_York';

/**
 * Converts a date range in Eastern Time to UTC date range for database queries
 * This ensures consistent midnight-to-midnight business day boundaries
 */
function getEasternDateRange(dateRange, startDate, endDate) {
  // Get current date in Eastern Time
  const now = new Date();
  const easternNow = toZonedTime(now, EASTERN_TIMEZONE);
  const todayEastern = format(easternNow, 'yyyy-MM-dd');
  
  // Determine date strings based on the selected range
  let startDateStr;
  let endDateStr;
  
  if (startDate && (dateRange === 'custom' || endDate)) {
    // For custom date range, extract just the date component in Eastern Time
    const startInEastern = toZonedTime(startDate, EASTERN_TIMEZONE);
    const endInEastern = endDate ? toZonedTime(endDate, EASTERN_TIMEZONE) : startInEastern;
    
    startDateStr = format(startInEastern, 'yyyy-MM-dd');
    endDateStr = format(endInEastern, 'yyyy-MM-dd');
  } else {
    // For predefined ranges
    switch (dateRange) {
      case 'today':
        startDateStr = todayEastern;
        endDateStr = todayEastern;
        break;
        
      case 'yesterday':
        const yesterdayEastern = subDays(easternNow, 1);
        startDateStr = format(yesterdayEastern, 'yyyy-MM-dd');
        endDateStr = startDateStr;
        break;
        
      case 'last7days':
        startDateStr = format(subDays(easternNow, 6), 'yyyy-MM-dd');
        endDateStr = todayEastern;
        break;
        
      case 'last30days':
        startDateStr = format(subDays(easternNow, 29), 'yyyy-MM-dd');
        endDateStr = todayEastern;
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
        
      default:
        startDateStr = todayEastern;
        endDateStr = todayEastern;
    }
  }
  
  // Now create date objects with Eastern midnight and 11:59:59 PM
  const startMidnight = new Date(`${startDateStr}T00:00:00`);
  const endMidnight = new Date(`${endDateStr}T23:59:59.999`);
  
  // Convert to UTC for database query
  // This is the critical part - we're setting the timestamps to represent 
  // midnight-to-midnight in Eastern Time
  const startUTC = toUTCDate(startMidnight, EASTERN_TIMEZONE, true);  // start of day
  const endUTC = toUTCDate(endMidnight, EASTERN_TIMEZONE, false);   // end of day
  
  return { start: startUTC, end: endUTC };
}

/**
 * Convert Eastern Time date to UTC
 * @param {Date} date - Date object with Eastern Time
 * @param {string} timezone - Timezone identifier
 * @param {boolean} isStartOfDay - Whether this is for start of day (true) or end of day (false)
 * @returns {Date} - Date object with UTC time
 */
function toUTCDate(date, timezone, isStartOfDay) {
  // Get the date string in Eastern Time
  const dateStr = format(date, 'yyyy-MM-dd');
  
  // Create the time string based on whether it's start or end of day
  const timeStr = isStartOfDay ? 'T00:00:00.000' : 'T23:59:59.999';
  
  // Get the timezone offset for this specific date (handles DST)
  const offset = formatInTimeZone(date, timezone, 'xxx');
  
  // Create an ISO string with the timezone offset
  const isoStr = `${dateStr}${timeStr}${offset}`;
  
  // Parse this into a Date object (will be converted to UTC)
  return new Date(isoStr);
}

module.exports = {
  getEasternDateRange,
  EASTERN_TIMEZONE
};