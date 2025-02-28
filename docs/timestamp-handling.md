# Timestamp Handling Strategy

## Overview
This project uses PostgreSQL's `timestamptz` type to store all timestamps in UTC while providing proper Eastern Time date boundary handling through SQL timezone conversions.

## Database Structure

### Storage
- All timestamps are stored as `timestamptz` (timestamp with time zone)
- PostgreSQL internally stores these in UTC
- Affected columns:
  - transactions.timestamp
  - orders.created_at, orders.closed_at
  - gift_cards.purchase_date
  - gift_card_redemptions.timestamp

### Timezone Handling
For accurate business day boundaries in Eastern Time, we use PostgreSQL's AT TIME ZONE operator:
```sql
SELECT created_at AT TIME ZONE 'America/New_York' as created_at_et
FROM orders
```

This ensures that:
1. Date boundaries align with Eastern Time business days
2. DST transitions are handled automatically
3. Queries can filter by local date using DATE()

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

### Reading Data by Date Ranges
For date-based queries, use WITH clause and AT TIME ZONE:
```sql
WITH orders_in_et AS (
  SELECT *, created_at AT TIME ZONE 'America/New_York' as created_at_et
  FROM orders
)
SELECT *
FROM orders_in_et
WHERE DATE(created_at_et) = '2025-02-28'::date
```

This ensures:
- Consistent midnight-to-midnight boundaries in Eastern Time
- Proper handling of DST transitions
- Accurate business day reporting

### Date Range Queries
Use `getUTCDateRange` utility for consistent business day boundaries:
```typescript
const { start, end } = getUTCDateRange('today');
// start will be midnight ET in UTC
// end will be 11:59:59.999 PM ET in UTC
```

## Utility Functions

### `toUTCStorage(date: Date)`
Ensures a date is in UTC for storage:
```typescript
const timestamp = toUTCStorage(new Date()); // For storing in database
```

### `formatInEasternTime(date: Date, format?: string)`
Formats a UTC timestamp in Eastern Time for display:
```typescript
const display = formatInEasternTime(order.createdAt);
// Returns e.g. "2025-02-28 07:00:00 EST"
```

### `getUTCDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date)`
Gets UTC date range that corresponds to Eastern Time business days:
```typescript
const { start, end } = getUTCDateRange('today');
// Returns timestamps aligned to ET midnight boundaries
```

## Testing
Test files in `server/tests/timestamp.test.ts` verify:
- Proper UTC storage
- Eastern Time date boundary handling
- DST transitions
- Date range query accuracy

## Common Scenarios

### Creating Records
```typescript
const order = {
  createdAt: new Date(), // Always use UTC
  // ...other fields
};
await pgStorage.createOrder(order);
```

### Querying Date Ranges
```typescript
// For reporting, use AT TIME ZONE conversion
const result = await db.execute(sql`
  WITH orders_in_et AS (
    SELECT *, created_at AT TIME ZONE 'America/New_York' as created_at_et
    FROM orders
  )
  SELECT *
  FROM orders_in_et
  WHERE DATE(created_at_et) >= ${startDate}
    AND DATE(created_at_et) <= ${endDate}
`);
```

### Dashboard Data
```typescript
// OrderSummary uses Eastern Time conversion for accurate business day reporting
const summary = await pgStorage.getOrderSummary('today');
```

## Troubleshooting

### Common Issues
1. Incorrect business day boundaries
   - Ensure using AT TIME ZONE 'America/New_York' for date-based queries
   - Use getUTCDateRange for consistent boundaries
   - Always use DATE() on timezone-converted fields

2. Timezone mismatches
   - Store dates using `new Date()` or explicit UTC times
   - Use AT TIME ZONE for display/reporting
   - Never manually adjust timestamps before storage

### Debugging
Enable detailed logging:
- Use dateUtils.ts logs showing timezone conversions
- Log both UTC and ET representations when debugging
- Verify date boundaries in queries match business requirements