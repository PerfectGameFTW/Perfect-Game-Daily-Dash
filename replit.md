# Perfect Game Sales Tracker

## Overview
A full-stack dashboard that syncs and visualizes daily sales, revenue, and gift card activity from the Square Payments API.

## Architecture
- **Frontend**: React + TypeScript + TanStack Query + shadcn/ui (Vite dev server)
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL via Drizzle ORM
- **Timezone**: UTC stored in DB; Eastern Time boundaries applied at query time via `getEasternDateRange` in `server/dateUtils.ts`

## Key Features
- Real-time sales dashboard with daily/weekly/monthly/custom date ranges
- Gift card sales tracking with activation amounts from Square Gift Card Activities API
- Nightly automatic sync at 3 AM Eastern Time (via `node-cron` scheduler)
- Admin panel: user management + data sync controls (full catch-up sync)
- "Last synced" indicator in dashboard header

## Data Sync Architecture
Two sync paths co-exist (legacy and service-based):
- **Legacy**: `server/routes.ts` — handles `/api/simple-sync`, `/api/full-sync`
- **Service-based**: `server/routes/api.ts` + `server/services/syncService.ts`

Sync types:
- `payments` — Square payment transactions
- `orders` — Square orders (line items, totals)
- `giftCards` — All active Square gift cards; activation amounts from Activities API
- `giftCardRedemptions` — Gift card usage linked to transactions

### Scheduled Sync
`server/services/schedulerService.ts` runs nightly at 3 AM ET:
1. Gift card full sync (all active cards)
2. Payments sync (last 3 days)
3. Orders sync (last 3 days)
4. Activation amount backfill via Gift Card Activities API

### Historical Catch-up
`POST /api/sync/historical` — starts a background process that chunks through monthly date ranges from a given start date through today, syncing orders and payments for each chunk, then runs a full gift card sync and activation backfill.

### Gift Card Historical Backfill (Task #4 fix)
`POST /api/sync/gift-cards-backfill` — resumable backfill that pages through ALL Square ACTIVATE events oldest-first via the Activities API. Saves a cursor checkpoint after every page so restarts resume mid-scan. Each call processes up to 20 pages (1,000 events). Call repeatedly until `finished: true` is returned. This fixes the March 9-20 gap where 228 cards were missed because `listGiftCards` has no date filter and lost pagination progress on server restart.

## Gift Card Activation Amounts
Fixed in Task #1. Root cause was that `activation_amount` was being set from current balance (wrong for spent cards). Now uses Square Gift Card Activities API (`ACTIVATE` events) as the authoritative source.

Key function: `server/squareClient.ts → fetchGiftCardActivitiesMap()` — returns `Map<squareId, amountDollars>`.

Repair/backfill: `server/services/enhancedGiftCardFix.ts → backfillGiftCardActivationAmounts()`.

## Bugs Fixed in Task #4 (March 9-20 gift card data gap)
1. **Bug 1 (PRIMARY)**: `syncGiftCards()` used `listGiftCards` API with no cursor checkpoint — server restarts lost pagination progress, leaving March 9-20 cards unreachable. Fixed by adding `syncGiftCardsHistoricalBackfill()` using Activities API with saved cursor.
2. **Bug 2 (field name)**: `syncService.ts` was setting `currentBalance` instead of `amount` in nightly full sync updates (silent no-op since `currentBalance` doesn't exist in schema). Fixed to use `amount`.
3. **Bug 3 (timezone)**: `convertSquareGiftCardToGiftCard()` called `toZonedTime()` which stored Eastern local time with UTC label (off by 4-5 hours). Fixed to store raw UTC directly from Square's `createdAt`. Historical backfill re-writes existing records with correct UTC timestamps.
4. **Bug 4 (schema drift)**: `activation_payment_id` column existed in DB but not in Drizzle schema. Added `activationPaymentId: integer("activation_payment_id")` to `shared/schema.ts`.

## API Endpoints
- `GET /api/summary` — daily summary (revenue, gift card sales, order count)
- `GET /api/gift-card-summary` — gift card sold/redeemed totals for a date range
- `GET /api/sync/status` — last sync timestamps per type
- `POST /api/sync/historical` — trigger background full catch-up sync (orders/payments)
- `POST /api/sync/gift-cards-backfill` — resumable gift card historical backfill (call until finished=true)
- `POST /api/fix-gift-cards` — re-run activation amount backfill
- `GET /api/analyze-gift-cards` — gift card coverage statistics

## Important Files
- `server/squareClient.ts` — Square API client, all fetch functions
- `server/services/syncService.ts` — orchestrates syncs, manages sync_state table
- `server/services/schedulerService.ts` — nightly cron scheduler
- `server/services/giftCardService.ts` — gift card DB queries, summary logic
- `server/services/enhancedGiftCardFix.ts` — activation amount backfill
- `server/dateUtils.ts` — Eastern Time boundary calculations
- `shared/schema.ts` — Drizzle ORM schema (single source of truth for types)
- `client/src/pages/Admin.tsx` — admin panel with user management and sync controls
- `client/src/components/dashboard/Header.tsx` — header with last-synced indicator
