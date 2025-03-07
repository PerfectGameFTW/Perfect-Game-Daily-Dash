# Timezone Handling Guide

## Overview

This document explains how timezone conversions are handled throughout the application, with particular focus on the critical business day boundaries in Eastern Time.

## Core Principles

1. **Database Storage**: All timestamps are stored in UTC (using PostgreSQL's `timestamptz` type).
2. **Business Days**: Business days are defined in Eastern Time (America/New_York), regardless of UTC time.
3. **Query Boundaries**: When querying for a business day, the UTC timestamps must align with Eastern Time boundaries.
4. **Daylight Saving Time**: The system accounts for DST transitions automatically.

## Timezone Conversion Reference

For Eastern Standard Time (EST), which is UTC-5:
- Eastern midnight (00:00:00 ET) = 05:00:00 UTC (same day)
- Eastern end of day (23:59:59.999 ET) = 04:59:59.999 UTC (next day)

For Eastern Daylight Time (EDT), which is UTC-4:
- Eastern midnight (00:00:00 ET) = 04:00:00 UTC (same day)
- Eastern end of day (23:59:59.999 ET) = 03:59:59.999 UTC (next day)

## Key Implementation Details

### Business Day Calculation

When calculating date ranges for "today", "yesterday" or other business periods, we:

1. Determine the date range in Eastern Time for display purposes
2. Convert the Eastern Time boundaries to precise UTC timestamps
3. Use these UTC timestamps directly in database queries

```typescript
// Example from dateUtils.ts
// For March 7th in Eastern Time:
// Start: March 7 00:00:00 ET = March 7 05:00:00 UTC
// End: March 7 23:59:59.999 ET = March 8 04:59:59.999 UTC
const startWithTZ = `${startStr}T00:00:00-05:00`;  // -05:00 represents Eastern Standard Time
const endWithTZ = `${endStr}T23:59:59.999-05:00`;

// Parse them to get UTC Date objects
const startDate = new Date(startWithTZ);
const endDate = new Date(endWithTZ);
```

### Critical Functions

1. **getEasternDateRange()**: Converts Eastern Time business day boundaries to UTC timestamps for database queries.
2. **utcToEastern()**: Converts UTC timestamps to Eastern Time for display purposes.
3. **getEasternHourFromUTC()**: Formats a UTC time as an Eastern Time hour for hourly reports.

## Common Timezone Issues

1. **Direction Error**: Always remember Eastern Time is behind UTC (subtract hours from UTC).
2. **DST Transitions**: Dates around DST changes require extra care as the UTC offset changes.
3. **Date Boundaries**: A single UTC day spans portions of two Eastern business days.

## Debugging Timezone Conversions

The application includes detailed logging for timezone conversions. Look for these log patterns:

```
Date range calculation: { ... }
Converting Eastern business days to UTC timestamps: { ... }
```

## Timezone Testing

When testing timezone-specific functionality:
1. Test dates in both standard time (winter) and daylight time (summer)
2. Test dates around DST transitions (usually March and November)
3. Verify late-night transactions (after 7pm ET) are attributed to the correct business day

## Technical Implementation

The implementation uses:
- `date-fns` for basic date manipulation
- `date-fns-tz` for timezone-aware formatting and parsing
- Native JavaScript Date objects (which are always in UTC internally)

## Previous Issues Fixed

The current implementation fixes a critical issue where transactions after 7:00 PM Eastern Time were incorrectly attributed to the next business day. This affected approximately 104 transactions ($9,113.05) on March 6, 2025, which were showing up as March 7 transactions.