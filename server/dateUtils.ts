/**
 * Timezone utilities for proper business day alignment
 *
 * ARCHITECTURE:
 * - All timestamps are stored in UTC (using timestamptz) in the database
 * - Business days are defined in Eastern Time (America/New_York)
 * - A business day runs from 6:00 AM ET to 5:59:59 AM ET the following calendar day,
 *   matching Square's daily reporting boundaries.
 * - Database queries use precise UTC timestamps that align with ET business days
 *
 * Example for the March 20 business day (EDT, UTC-4):
 *   ET business day:  2026-03-20 06:00:00 ET  →  2026-03-21 05:59:59.999 ET
 *   Stored as UTC:    2026-03-20 10:00:00 UTC  →  2026-03-21 09:59:59.999 UTC
 *
 * The correct conversion is fromZonedTime(etDateString, 'America/New_York') which
 * takes a wall-clock time IN Eastern and returns the equivalent UTC moment.
 */
import { format, subMonths, endOfMonth } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { DateRange } from '@shared/schema';

export const EASTERN_TIMEZONE = 'America/New_York';

/**
 * The hour (in Eastern Time) at which a new business day begins.
 * Matches Square's daily reporting: 6 AM ET start.
 */
const BUSINESS_DAY_START_HOUR = 6;

/**
 * Returns the ET business date string (yyyy-MM-dd) for the current moment.
 * Before 6 AM ET the business day is still the previous calendar date.
 */
function currentBusinessDayET(now: Date): string {
  const calendarDateET = formatInTimeZone(now, EASTERN_TIMEZONE, 'yyyy-MM-dd');
  const hourET = parseInt(formatInTimeZone(now, EASTERN_TIMEZONE, 'H'), 10);

  if (hourET < BUSINESS_DAY_START_HOUR) {
    const [y, m, d] = calendarDateET.split('-').map(Number);
    const prevDay = new Date(y, m - 1, d - 1);
    return format(prevDay, 'yyyy-MM-dd');
  }

  return calendarDateET;
}

/**
 * Given a business-day date string (yyyy-MM-dd), advance it by one calendar day.
 */
function addOneCalendarDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return format(new Date(y, m - 1, d + 1), 'yyyy-MM-dd');
}

/**
 * Returns the UTC start and end timestamps that bracket the given date range
 * as experienced in Eastern Time, using 6 AM ET as the business day boundary.
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
  const todayET = currentBusinessDayET(now);

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
        const [year, month] = todayET.split('-');
        startStr = `${year}-${month}-01`;
        endStr   = todayET;
        break;
      }

      case 'lastMonth': {
        const [y, m] = todayET.split('-').map(Number);
        const thisMonthStart = new Date(y, m - 1, 1);
        const lastMonthStart = subMonths(thisMonthStart, 1);
        const lastMonthEnd   = endOfMonth(lastMonthStart);
        startStr = format(lastMonthStart, 'yyyy-MM-dd');
        endStr   = format(lastMonthEnd,   'yyyy-MM-dd');
        break;
      }

      case 'yearToDate': {
        const [year] = todayET.split('-');
        startStr = `${year}-01-01`;
        endStr   = todayET;
        break;
      }

      default:
        startStr = todayET;
        endStr   = todayET;
    }
  }

  // Business day start: 6:00 AM ET on startStr
  // Business day end:   5:59:59.999 AM ET on the calendar day AFTER endStr
  const startUTC = fromZonedTime(`${startStr}T06:00:00`, EASTERN_TIMEZONE);
  const endUTC   = fromZonedTime(`${addOneCalendarDay(endStr)}T05:59:59.999`, EASTERN_TIMEZONE);

  return { start: startUTC, end: endUTC };
}

export function getEasternBusinessDateStrings(
  dateRange: DateRange,
  inputStartDate?: Date,
  inputEndDate?: Date
): { startStr: string; endStr: string } {
  const now = new Date();
  const todayET = currentBusinessDayET(now);

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
        const [year, month] = todayET.split('-');
        startStr = `${year}-${month}-01`;
        endStr   = todayET;
        break;
      }

      case 'lastMonth': {
        const [y, m] = todayET.split('-').map(Number);
        const thisMonthStart = new Date(y, m - 1, 1);
        const lastMonthStart = subMonths(thisMonthStart, 1);
        const lastMonthEnd   = endOfMonth(lastMonthStart);
        startStr = format(lastMonthStart, 'yyyy-MM-dd');
        endStr   = format(lastMonthEnd,   'yyyy-MM-dd');
        break;
      }

      case 'yearToDate': {
        const [year] = todayET.split('-');
        startStr = `${year}-01-01`;
        endStr   = todayET;
        break;
      }

      default:
        startStr = todayET;
        endStr   = todayET;
    }
  }

  return { startStr, endStr };
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
