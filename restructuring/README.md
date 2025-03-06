# Database and Service Layer Restructuring

This directory contains a comprehensive restructuring of the database architecture and service layer for the sales dashboard application. The goal is to create a more maintainable, testable, and extensible system while addressing specific issues related to gift card tracking, timezone handling, and Square API synchronization.

## Benefits of the New Architecture

1. **Improved Database Schema Design**
   - Clear separation of concerns with properly normalized tables
   - Better relationship modeling between entities
   - Explicit tracking of gift card activation amounts

2. **UTC-Based Timezone Handling**
   - All timestamps stored in UTC for consistency
   - Business logic handles proper timezone conversions
   - No special cases or date-specific handling needed

3. **Service-Oriented Architecture**
   - Business logic isolated in dedicated service classes
   - Clear interfaces between layers
   - Better testability and maintainability

4. **Enhanced Error Handling**
   - Consistent error types throughout the application
   - Proper propagation of errors with typed classes
   - Better error reporting to the UI

5. **Improved API Organization**
   - Clear route definitions
   - Standardized request and response handling
   - Structured error responses

## Implementation Components

### Database Schema (`schema.ts`)

Defines the database schema with proper table relationships and optimized data structures. Key improvements:

- `payments` table replaces the old `transactions` table with better organization
- `payment_sources` table for tracking payment methods
- Explicit tracking of gift card activation amounts
- Unified timestamp handling (all UTC-based)

### Storage Interface (`storage.ts`)

Defines a clear interface for data access with strongly typed methods. All storage operations go through this interface, which isolates database interactions from business logic.

### Database Implementation (`pgStorage.ts`)

Provides a PostgreSQL implementation of the storage interface using Drizzle ORM. Features:

- Consistent error handling
- Transaction support
- Performance optimizations

### Service Layer

The service layer implements business logic and provides a clean API for the frontend:

- `OrderService`: Manages order data and operations
- `PaymentService`: Handles payment processing and tracking
- `GiftCardService`: Manages gift card operations
- `SyncService`: Coordinates Square API synchronization

### Date Utilities (`dateUtils.ts`)

Provides comprehensive timezone handling with functions for:

- Converting between UTC and Eastern Time
- Calculating date ranges
- Formatting dates for display

### API Routes (`routes/apiRouter.ts`)

Defines the API endpoints with consistent request/response handling and error formatting.

## Migration

The migration from the old system to the new one is handled by several scripts:

1. `migration.ts`: General database migration
2. `giftCardImprovement.ts`: Specific gift card data improvements
3. `implementImprovements.ts`: Orchestrates the migration process

A CLI tool (`run-migration.ts`) is provided to execute and monitor the migration.

## How to Use

### Running the Migration

To safely migrate to the new system:

1. **Dry Run**: Test what would happen without making changes
   ```
   npx tsx restructuring/run-migration.ts dry-run
   ```

2. **Verify Current State**: Check database status
   ```
   npx tsx restructuring/run-migration.ts verify
   ```

3. **Apply Migration**: Perform the actual migration
   ```
   npx tsx restructuring/run-migration.ts apply
   ```

4. **Fix Gift Cards Only**: Apply only gift card fixes
   ```
   npx tsx restructuring/run-migration.ts fix-gift-cards
   ```

### Adopting the New Structure

Once migration is complete, the new architecture can be integrated:

1. Replace existing files with their restructured counterparts
2. Update imports to refer to the new modules
3. Remove deprecated scripts that are no longer needed

## Maintenance Notes

- When adding new features, follow the service-oriented pattern
- Use the storage interface for all database operations
- Always use UTC dates in the database and convert only for display
- Add comprehensive tests for new services