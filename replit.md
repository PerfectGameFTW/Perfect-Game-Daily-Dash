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

## Gift Card Activation Amounts
Fixed in Task #1. Root cause was that `activation_amount` was being set from current balance (wrong for spent cards). Now uses Square Gift Card Activities API (`ACTIVATE` events) as the authoritative source.

Key function: `server/squareClient.ts → fetchGiftCardActivitiesMap()` — returns `Map<squareId, amountDollars>`.

Repair/backfill: `server/services/enhancedGiftCardFix.ts → backfillGiftCardActivationAmounts()`.

## API Endpoints
- `GET /api/summary` — daily summary (revenue, gift card sales, order count)
- `GET /api/gift-card-summary` — gift card sold/redeemed totals for a date range
- `GET /api/sync/status` — last sync timestamps per type
- `POST /api/sync/historical` — trigger background full catch-up sync
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
