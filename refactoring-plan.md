# UTC Refactoring Plan

## Current Issues
- Using Eastern Time Zone in database views creates inconsistencies
- Timezone handling in the application adds complexity
- Date range calculations between server and client have discrepancies

## Refactoring Goals
- Store all timestamps in UTC in the database (already in place)
- Use UTC for all database operations
- Convert to timezone-specific formats only at the display layer
- Simplify date range handling by using unified UTC date ranges

## Implementation Steps

### 1. Database Layer
- Create new UTC-based queries in the pgStorage.ts file 
- Remove reliance on Eastern Timezone in database views
- Update getGiftCardSales function to use UTC calculations

### 2. Server Logic
- Simplify getEasternDateRange function to work with UTC dates
- Update timezone conversion in server routes
- Modify dateUtils.ts to focus on UTC date handling with display conversions

### 3. Frontend Display
- Keep timezone display conversion in frontend only
- Update client components to handle timezone display
- Update date filtering logic in buildQueryString helper

## Implementation Details

### Backend (pgStorage.ts)
- Replace ET-specific SQL queries with UTC queries
- Add timezone parameter to summary calculation functions
- Use direct UTC comparison for date ranges

### Display Layer (client components)
- Move timezone formatting to the UI components
- Use utility functions for timezone display
- Keep date navigation and selection in local timezone

### Date Handling
- Standardize on ISO format for date transmission
- Use consistent date boundary calculation
- Simplify date range calculations with UTC

## Testing Plan
- Test timezone conversion accuracy
- Verify date range handling across different situations
- Ensure consistent results for gift card sales data