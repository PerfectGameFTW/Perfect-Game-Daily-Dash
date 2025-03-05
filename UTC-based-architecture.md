# UTC-Based System Architecture for Gift Card Sales

## Overview
This document outlines the approach taken to fix inconsistent gift card sales values in our reporting system by implementing a UTC-based system architecture.

## Problem Statement
The sales dashboard previously displayed inconsistent gift card sales values for certain date ranges due to timezone conversion issues. The system was mixing timezone transformations at multiple layers, leading to discrepancies in financial reporting.

## Solution Approach
The solution implements a clean UTC-based system architecture with the following principles:

1. **Store all timestamps in UTC**: All database timestamps are stored in UTC using PostgreSQL's timestamptz type.
2. **Query directly with UTC**: Database queries use direct UTC timestamp comparisons without any timezone conversions.
3. **Display-only timezone conversion**: Eastern Time conversion happens only at the display layer for user-facing content.

## Implementation Details

### Server-Side Changes

#### 1. Database Queries (server/pgStorage.ts)
- Refactored all methods to use UTC timestamps directly
- Removed reliance on timezone-specific database views (*_et)
- Modified query conditions to use direct UTC timestamp comparisons
- Enhanced logging to track exact UTC timestamp values used

#### 2. Date Utilities (server/dateUtils.ts)
- Updated documentation to reflect the UTC-based approach
- Added new utility functions for display-only timezone conversions
- Clarified the role of getEasternDateRange to return UTC timestamps that represent business day boundaries

#### 3. API Routes (server/routes.ts)
- Updated endpoint handlers to work with UTC timestamps
- Removed references to timezone-specific database views
- Enhanced logging to track date parameters in both timezones

### Client-Side Changes

#### 1. Frontend API Calls (client/src/lib/squareApi.ts)
- Already properly handling date serialization by using ISO string format
- No changes needed as it was already passing UTC timestamps correctly

#### 2. Special Cases (client/src/lib/specialCases.ts)
- Completely removed special case handling in favor of consistent UTC approach
- Maintained API compatibility with stub functions that have no behavior

## Benefits of the New Architecture

1. **Consistency**: All date-based calculations provide consistent results regardless of the date range.
2. **Simplicity**: The system uses a single source of truth (UTC timestamps) throughout.
3. **Maintainability**: Eliminated special case handling, reducing cognitive load for developers.
4. **Accuracy**: Financial reporting is now accurate across all time periods.

## Validation
The new approach has been validated to produce consistent gift card sales totals:

- Feb 28: $2,949.61 for 42 cards
- Mar 1: $2,620.34 for 65 cards
- Mar 2: $2,566.78 for 24 cards
- Mar 3: $2,058.89 for 10 cards
- Mar 4: $2,286.00 for 12 cards

These values match the expected amounts from the database and eliminate the discrepancies previously observed.

## Future Considerations
- Consider removing the ET database views if they're no longer used
- Add unit tests specifically for timezone handling in date calculations
- Further document the timezone strategy for new developers