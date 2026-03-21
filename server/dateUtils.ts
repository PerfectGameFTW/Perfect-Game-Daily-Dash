/**
 * Timezone utilities for proper business day alignment
 *
 * ARCHITECTURE:
 * - All timestamps are stored in UTC (using timestamptz) in the database
 * - Business days are defined in Eastern Time (America/New_York)
 * - Database queries use precise UTC timestamps that align with ET business days
 *
 * Example for March 21 (EDT, UTC-4):
 *   ET business day:  2026-03-21 00:00:00 ET  →  2026-03-21 23:59:59.999 ET
 *   Stored as UTC:    2026-03-21 04:00:00 UTC  →  2026-03-22 03:59:59.999 UTC
 *
 * The correct conversion is fromZonedTime(etDateString, 'America/New_York') which
 * takes a wall-clock time IN Eastern and returns the equivalent UTC moment.
 */
import { format, subDays, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { DateRange } from '@shared/schema';

export const EASTERN_TIMEZONE = 'America/New_York';

/**
 * Returns the UTC start and end timestamps that bracket the given date range
 * as experienced in Eastern Time.
 *
 * All arithmetic is done in ET date strings first, then converted to UTC
 * using fromZonedTime so that DST is handled automatically.
 */
export function getEasternDateRange(
  dateRange: DateRange,
  inputStartDate?: Date,
  inputEndDate?: Date
): { start: Date; end: Date } {
  const now = new Date();

  // "today" in Eastern Time as a yyyy-MM-dd string
  const todayET = formatInTimeZone(now, EASTERN_TIMEZONE, 'yyyy-MM-dd');

  let startStr: string;
  let endStr: string;

  if (inputStartDate && inputEndDate && dateRange === 'custom') {
    startStr = formatInTimeZone(inputStartDate, EASTERN_TIMEZONE, 'yyyy-MM-dd');
    endStr   = formatInTimeZone(inputEndDate,   EASTERN_TIMEZONE, 'yyyy-MM-dd');
  } else {
    switch (dateRange) {
      case 'today':
        startStr = todayET;
        endStr   = todayET;
        break;

      case 'yesterday': {
        // Subtract one calendar day from the ET "today" string to stay in ET space
        const [y, m, d] = todayET.split('-').map(Number);
        const yesterdayET = new Date(y, m - 1, d - 1);
        startStr = format(yesterdayET, 'yyyy-MM-dd');
        endStr   = startStr;
        break;
      }

      case 'last7days': {
        const [y, m, d] = todayET.split('-').map(Number);
        const sixDaysAgo = new Date(y, m - 1, d - 6);
        startStr = format(sixDaysAgo, 'yyyy-MM-dd');
        endStr   = todayET;
        break;
      }

      case 'last30days': {
        const [y, m, d] = todayET.split('-').map(Number);
        const twentyNineDaysAgo = new Date(y, m - 1, d - 29);
        startStr = format(twentyNineDaysAgo, 'yyyy-MM-dd');
        endStr   = todayET;
        break;
      }

      case 'thisMonth': {
        // Use the ET "today" string to get the correct month — avoids UTC/ET day-boundary issues
        const [year, month] = todayET.split('-');
        startStr = `${year}-${month}-01`;
        endStr   = todayET;
        break;
      }

      case 'lastMonth': {
        // Build a plain local date from the ET today string so month arithmetic is clean
        const [y, m, d] = todayET.split('-').map(Number);
        const thisMonthStart = new Date(y, m - 1, 1);
        const lastMonthStart = subMonths(thisMonthStart, 1);
        const lastMonthEnd   = endOfMonth(lastMonthStart);
        startStr = format(lastMonthStart, 'yyyy-MM-dd');
        endStr   = format(lastMonthEnd,   'yyyy-MM-dd');
        break;
      }

      default:
        startStr = todayET;
        endStr   = todayET;
    }
  }

  // Convert ET wall-clock midnight / end-of-day to the correct UTC moments.
  // fromZonedTime('2026-03-21T00:00:00', 'America/New_York') correctly returns
  // 2026-03-21T04:00:00Z during EDT (UTC-4), accounting for DST automatically.
  const startUTC = fromZonedTime(`${startStr}T00:00:00`, EASTERN_TIMEZONE);
  const endUTC   = fromZonedTime(`${endStr}T23:59:59.999`, EASTERN_TIMEZONE);

  console.log('Date range calculation:', {
    range: dateRange,
    startET: `${startStr}T00:00:00`,
    endET:   `${endStr}T23:59:59.999`,
    startUTC: startUTC.toISOString(),
    endUTC:   endUTC.toISOString(),
  });

  return { start: startUTC, end: endUTC };
}

/** Format a date for display in Eastern Time */
export function formatEasternDate(date: Date): string {
  return formatInTimeZone(date, EASTERN_TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Convert a UTC date to an Eastern Time Date object (for display only).
 * Not used for database queries.
 */
export function utcToEastern(date: Date): Date {
  const easternISOString = formatInTimeZone(date, EASTERN_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
  return new Date(easternISOString);
}

/** Format a 24-hour number (0–23) to a 12-hour AM/PM label */
export function formatHour(hour: number): string {
  if (hour === 0)  return '12 AM';
  if (hour === 12) return '12 PM';
  if (hour < 12)   return `${hour} AM`;
  return `${hour - 12} PM`;
}

/** Convert a UTC timestamp to the Eastern Time hour label (e.g. "9 PM") */
export function getEasternHourFromUTC(utcDate: Date): string {
  const easternHour = formatInTimeZone(utcDate, EASTERN_TIMEZONE, 'H');
  return formatHour(parseInt(easternHour, 10));
}
