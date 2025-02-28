# Timestamp Handling Strategy

## Overview
This project uses PostgreSQL's `timestamptz` type to store all timestamps in UTC while providing Eastern Time views for reporting and business day alignment.

## Database Structure

### Storage
- All timestamps are stored as `timestamptz` (timestamp with time zone)
- PostgreSQL internally stores these in UTC
- Affected columns:
  - transactions.timestamp
  - orders.created_at, orders.closed_at
  - gift_cards.purchase_date
  - gift_card_redemptions.timestamp

### Views
Read-only views provide Eastern Time conversions for reporting:
- `transactions_et`
- `orders_et`
- `gift_cards_et`
- `gift_card_redemptions_et`

Each view adds `_et` suffixed columns that show the Eastern Time equivalent of UTC timestamps.

## Best Practices

### Writing Data
```typescript
// Always write timestamps in UTC
const order = {
  squareId: 'order_123',
  createdAt: new Date(), // PostgreSQL will store this in UTC
  // ...other fields
};
await pgStorage.createOrder(order);
```

### Reading Data
For reporting/dashboard queries, use the Eastern Time views:
```sql
-- Example: Get orders for a business day in Eastern Time
SELECT * FROM orders_et
WHERE DATE(created_at_et) = '2025-02-28';
```

### Date Range Queries
Use the `getUTCDateRange` utility for consistent business day boundaries:
```typescript
const { start, end } = getUTCDateRange('today');
// start will be midnight ET in UTC
// end will be 11:59:59.999 PM ET in UTC
```

## Utility Functions

### `toUTCStorage(date: Date)`
Ensures a date is in UTC for storage.

### `formatInEasternTime(date: Date, format?: string)`
Formats a UTC timestamp in Eastern Time for display.

### `toEasternTime(date: Date)`
Converts a UTC date to Eastern Time for processing.

### `getUTCDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date)`
Gets UTC date range that corresponds to Eastern Time business days.

## Testing
Test files in `server/tests/timestamp.test.ts` verify:
- Proper UTC storage
- Eastern Time view conversions
- Date range handling
- Business day boundary cases

## Common Scenarios

### Creating Records
```typescript
// Timestamps will automatically be stored in UTC
const transaction = {
  timestamp: new Date(),
  // ...other fields
};
await pgStorage.createTransaction(transaction);
```

### Querying Date Ranges
```typescript
// For reporting, use Eastern Time views
const result = await db.execute(sql`
  SELECT * FROM transactions_et
  WHERE DATE(timestamp_et) >= ${startDate}
    AND DATE(timestamp_et) <= ${endDate}
`);
```

### Dashboard Data
```typescript
// OrderSummary uses Eastern Time views for accurate business day reporting
const summary = await pgStorage.getOrderSummary('today');
```

## Troubleshooting

### Common Issues
1. Incorrect business day boundaries
   - Make sure to use Eastern Time views for reporting
   - Use `getUTCDateRange` for date range queries

2. Timezone mismatches
   - Always store dates using `new Date()` or explicit UTC times
   - Use Eastern Time views for display/reporting
   - Never manually convert timestamps before storage

### Debugging
Enable detailed logging by checking dateUtils.ts logs which show:
- Input/output of timezone conversions
- Date range calculations
- Eastern Time boundaries
