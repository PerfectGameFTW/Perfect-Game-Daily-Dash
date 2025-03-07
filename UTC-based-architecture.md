# UTC-Based Architecture with Eastern Time Business Logic

## Architecture Overview

This document outlines the architectural approach for handling timezone conversions in our sales analytics platform, ensuring accurate data representation across time boundaries.

## Design Principles

1. **Single Source of Truth**: All timestamps are stored in UTC in the database.
2. **Business Logic in Eastern Time**: All business day definitions, reporting periods, and user-facing dates are in Eastern Time.
3. **Clear Boundary Translation**: UTC database queries use explicit time boundaries derived from Eastern Time business days.
4. **No Implicit Conversions**: All timezone conversions are explicit and documented.

## System Components

### Database Layer
- PostgreSQL with `timestamptz` type for all date/time fields
- All timestamps stored in UTC without exception
- No timezone conversion in SQL queries (pure UTC)

### Data Access Layer
- `pgStorage.ts` handles database queries using UTC time ranges
- Query parameters created from Eastern Time business boundaries

### Business Logic Layer
- `dateUtils.ts` contains all timezone conversion logic
- `getEasternDateRange()` converts business days to precise UTC query boundaries
- Service classes (PaymentService, OrderService, etc.) use these UTC boundaries

### Presentation Layer
- All dates displayed in Eastern Time for user consistency
- Date selection UI (calendar, date range picker) works in Eastern Time

## Key Implementation Details

### Business Day Boundaries
A business day in Eastern Time spans multiple UTC days:
- Eastern Time: March 7, 2025 (00:00:00 to 23:59:59.999)
- UTC: March 7, 2025 05:00:00 to March 8, 2025 04:59:59.999

### Date Range Handling
Date ranges like "today", "yesterday", "last7days" are all defined in terms of Eastern Time business days, then translated to UTC query boundaries.

### Daylight Saving Time
The system correctly handles DST transitions by:
1. Using the `date-fns-tz` library for timezone-aware operations
2. Specifying the IANA timezone identifier 'America/New_York'
3. Allowing JavaScript's Date object to handle the UTC conversion

## Debugging and Testing

### Logging
Comprehensive logging is implemented at all timezone conversion points:
- Input/output timestamps are logged with timezone information
- Conversion explanations are included in logs

### Testing Strategy
Test cases specifically verify:
1. Standard Time conversions (November-March)
2. Daylight Time conversions (March-November) 
3. DST transition days
4. Late-night transactions (7 PM - midnight ET)

## Previous Issues and Solutions

During initial development, a critical timezone direction error caused transactions after 7:00 PM ET to be incorrectly attributed to the next business day. This was fixed by properly implementing the getEasternDateRange() function to correctly calculate UTC timestamp boundaries from Eastern Time business days.

## Further Reading

For detailed implementation specifics, refer to:
1. `docs/timestamp-handling.md` - Detailed documentation of timezone handling
2. Code comments in `server/dateUtils.ts`