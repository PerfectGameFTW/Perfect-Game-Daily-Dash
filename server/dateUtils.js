// Simple Eastern Time Date Utility
// Stores date ranges in Eastern Time instead of UTC for database queries

const { format, addDays, subDays, startOfMonth, endOfMonth, subMonths } = require('date-fns');
const { formatInTimeZone, toZonedTime } = require('date-fns-tz');

const EASTERN_TIMEZONE = 'America/New_York';

/**
 * Converts a date range in Eastern Time and returns it as an Eastern Time string
 * Ensures consistent midnight-to-midnight business day boundaries in EST/EDT
 */
function getEasternDateRange(dateRange, startDate, endDate) {
  console.log('DIAGNOSTIC - Processing date range request:', { dateRange, startDate, endDate });

  // Get the current date in Eastern Time for date range calculations
  const now = new Date();
  const easternNow = toZonedTime(now, EASTERN_TIMEZONE);
  const todayEasternStr = format(easternNow, 'yyyy-MM-dd');

  // Variables to store our date range strings
  let startDateStr;
  let endDateStr;

  // Determine date strings based on range type
  if (startDate && (dateRange === 'custom' || endDate)) {
    const startInEastern = toZonedTime(startDate, EASTERN_TIMEZONE);
    const endInEastern = endDate ? toZonedTime(endDate, EASTERN_TIMEZONE) : startInEastern;

    startDateStr = format(startInEastern, 'yyyy-MM-dd');
    endDateStr = format(endInEastern, 'yyyy-MM-dd');

    console.log('Custom date range in Eastern Time:', { startDateStr, endDateStr });
  } else {
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
        startDateStr = format(startOfMonth(easternNow), 'yyyy-MM-dd');
        endDateStr = format(endOfMonth(easternNow), 'yyyy-MM-dd');
        break;
      case 'lastMonth':
        const lastMonthDate = subMonths(easternNow, 1);
        startDateStr = format(startOfMonth(lastMonthDate), 'yyyy-MM-dd');
        endDateStr = format(endOfMonth(lastMonthDate), 'yyyy-MM-dd');
        break;
      case 'custom':
        throw new Error('Start date and end date must be provided for custom date range');
      default:
        startDateStr = todayEasternStr;
        endDateStr = todayEasternStr;
    }
  }

  // Store the dates as Eastern Time strings instead of converting to UTC
  const startEasternStr = `${startDateStr}T00:00:00.000`;
  const endEasternStr = `${endDateStr}T23:59:59.999`;

  console.log('FINAL DATABASE QUERY RANGE (EASTERN TIME):', {
    easternStart: startEasternStr,
    easternEnd: endEasternStr
  });

  return { start: startEasternStr, end: endEasternStr };
}

module.exports = {
  getEasternDateRange,
  EASTERN_TIMEZONE
};
