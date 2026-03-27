# Perfect Game Sales Tracker

## Overview
A full-stack dashboard that syncs and visualizes daily sales, revenue, and gift card activity from the Square Payments API.

## Architecture
- **Frontend**: React + TypeScript + TanStack Query + shadcn/ui (Vite dev server)
- **Backend**: Express.js + TypeScript
- **Square SDK**: `square` v44.0.1 (uses `SquareClient` / `SquareEnvironment` — no axios dependency)
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
- `refunds` — Square refunds via the dedicated Refunds API (separate from payments)

### Scheduled Sync
`server/services/schedulerService.ts` runs every 5 minutes + nightly at 3 AM ET:
1. Gift card full sync (all active cards)
2. Payments sync (last 3 days nightly / last 15 min frequent)
3. Orders sync (last 3 days nightly / last 15 min frequent)
4. Refunds sync (last 3 days nightly / last 15 min frequent)
5. Activation amount backfill via Gift Card Activities API

### Historical Catch-up
`POST /api/sync/historical` — starts a background process that chunks through monthly date ranges from a given start date through today, syncing orders, payments, and refunds for each chunk, then runs a full gift card sync and activation backfill.

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

## Refund & Return Tracking (Task #10)
Root cause: Dashboard showed $0.00 refunds because it checked for negative payment amounts, but Square stores refunds as separate API objects (not negative payments). Fixed by:
1. Added `refunds` DB table (`shared/schema.ts`) with fields: squareRefundId, squarePaymentId, amount, status, reason (nullable), createdAt, squareData
2. Added `fetchRefunds()` in `server/squareClient.ts` using Square's `RefundsApi.listPaymentRefunds()`
3. Added `syncRefunds()` to `syncService.ts`, wired into both 5-min and nightly sync schedules
4. Updated `dashboardService.ts` to query refunds table instead of checking negative payment amounts
5. Backfilled 843 historical refunds from Jan 1, 2025

**Refunds vs Returns (CRITICAL — these are two completely separate things in Square)**:
Square treats refunds and returns as distinct objects. They are queried separately and must always be tracked separately in the database and backend, even when the UI combines them for display purposes.
- **Refunds**: Refund records with NO reason field. Represents a straight money-back refund. The full refund amount is used.
- **Returns**: Refund records WITH a reason field (e.g., "Accidental Charge"). Represents returned items. The amount used is pre-tax (total refund minus return tax, looked up from order's `returnAmounts.taxMoney`).
- **Taxes**: Reduced by the tax portion of returns (from order-level `returnAmounts.taxMoney`).
- The `getDetailedTransactionBreakdown()` in `dashboardService.ts` queries refunds and returns with separate SQL queries (filtering by `reason IS NULL` vs `reason IS NOT NULL`).
- The `getRevenueBreakdown()` in `paymentService.ts` queries ALL refunds (both types combined) for the True Revenue calculation.
- The Summary Stats UI may combine them for display (e.g., "Refunds + Returns" line), but the underlying data must always keep them separate for other views that break them out individually.

## CC Processing Fee Tracking (Payout Fees)
Square's cost-plus pricing model charges the full processing fee per transaction, then reimburses the overcharge via payout entries. The dashboard tracks this via:
- **payout_fee_entries table**: Stores CHARGE (initial fees deducted), FEE (cost-plus reimbursements), and THIRD_PARTY_FEE entries from Square's Payouts API
- **PayoutService** (`server/services/payoutService.ts`): Syncs payout entries from Square. Initial sync fetches from Jan 2025; incremental syncs cover last 7 days. Runs nightly + on startup.
- **Dashboard integration**: `getProcessingFees()` in dashboardService queries by date range; returns initialFees, reimbursements, thirdPartyFees, netFees
- **UI**: StatsSummary shows CC Processing Fees section with breakdown and "Net Revenue After Fees"
- **Timing caveat**: Cost-plus reimbursements may lag 1-2 business days; monthly totals more accurate than daily

## Intercard Revenue Integration (Task #18)
Intercard is the arcade game card system. Revenue data is fetched from the Intercard Revenue Extract REST API and displayed as a separate line item in the dashboard.
- **Service**: `server/services/intercardService.ts` — API client with JWT auth, daily sync, historical backfill from Jan 1, 2025
- **DB table**: `intercard_revenue` — stores per-device daily revenue rows (date, locationId, deviceType, revenue, etc.)
- **Auth**: JWT token obtained from `/WS_RevenueExtract_REST/api/Tokens/corp/:corpId/GetJwt`, cached for 50 minutes
- **Env vars**: `INTERCARD_HOST`, `INTERCARD_MAC_ID`, `INTERCARD_CORP_ID`
- **Scheduler**: syncToday() runs every 60 seconds + nightly; historical backfill runs on startup
- **Dashboard**: Intercard revenue included in True Revenue KPI, shown as line item below Tripleseat Deposits in StatsSummary
- **Date handling**: Uses Eastern Time for date formatting and DST-aware UTC offset for API calls

## Gift Card Sales & Redemption Classification (Task #20 / #21 / #23)

### Business Context
Web reservations are booked through **Qubica** (QubicaAMF channel), not Partywirks.
- **Bowling web reservations**: Booked via Qubica, order source = `Web Reservation`
- **Laser tag web reservations**: Booked via Qubica, order source = `Web Reservation-Attraction`
- **Multi Attractions Reservation**: Booked via Qubica, order source = `Multi Attractions Reservation` (classified as laser tag)
- **Partywirks**: Separate birthday booking software, charges $100 deposit increments — unrelated to web reservations

When a customer books online, two things happen simultaneously in Square:
1. A Web Reservation order is created with the deposit amount
2. An electronic gift card is activated for that same amount, linked to the order

When the customer arrives, staff redeems the gift card to clear the deposit.
All web reservation deposit gift cards are electronic. True gift card sales (bought as gifts) are rare and also electronic.

### Source Buckets
| Order Source | Dashboard Category |
|---|---|
| `Web Reservation` | Bowling Web Res Deposits |
| `Multi Attractions Reservation` | Laser Tag Web Res Deposits |
| `Web Reservation-Attraction` | Laser Tag Web Res Deposits |
| Everything else (incl. NULL, `Terminal`, `unknown`, etc.) | True Gift Card Sales/Redemptions |

### Deposits Side (`giftCardService.ts → getGiftCardBreakdown`)
- Queries `orders` table directly by `source`, confirmed with deposit line item filter (`EXISTS order_line_items.name = 'Deposit'`)
- No dependency on `gift_cards` table linkage
- `giftCardSales` = total SQUARE_GIFT_CARD tender amounts (from `orders.square_data` JSON) minus bowling deposits minus laser tag deposits

### Redemption Side (`dashboardService.ts → getDetailedTransactionBreakdown`)
- **Total** from DB: sums `SQUARE_GIFT_CARD` tender amounts from `orders.square_data`
- **Classification**: fetches `REDEEM` activities from Square Gift Card Activities API, which returns the exact `giftCardId` for each redemption, then resolves back to the original activation order to determine the source
- **Resolution pipeline** (3 tiers):
  1. **DB link (primary)**: `gift_cards.activation_square_order_id → orders.source` — direct link from the gift card to its activation order. Post-April 2025 cards have ~100% linkage, making this the only tier needed for new cards.
  2. **ACTIVATE API fallback**: For cards missing a DB link, queries Square's ACTIVATE activity API for the card's activation order ID, fetches missing orders via batch retrieve if needed, then checks the order source.
  3. **Heuristic closest-match**: For pre-April 2025 cards where the ACTIVATE API also returns no data, matches `gift_cards.activation_amount` to the closest `orders.total_money` for web reservation sources by time proximity (CROSS JOIN LATERAL). Logs matches with >24h gaps for transparency. This tier handles legacy data only.
- Graceful degradation: if API calls fail, the entire redemption total falls back to pure GC redemptions

### Linkage Health
- Pre-March 2025: 100% of cards missing links (historical debt, ~2,659 cards)
- March 2025: ~60% missing (transition month when backfill system was built)
- April 2025 onward: ~0% missing — linkage is reliable for all new cards
- The owner is clearing pre-April 2025 card balances in Square; once complete, the heuristic tier will rarely be needed

### Key Functions
- `squareClient.ts → fetchGiftCardRedeemActivities(beginTime, endTime)` — REDEEM activities for date range
- `squareClient.ts → fetchGiftCardActivateActivity(giftCardId)` — single card's ACTIVATE activity (fallback)
- `squareClient.ts → fetchOrdersByIds(orderIds)` — batch retrieve orders from Square API
- `giftCardService.ts → getGiftCardBreakdown()` — deposits-side breakdown
- `dashboardService.ts → getDetailedTransactionBreakdown()` — redemption-side classification

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
- `server/services/payoutService.ts` — CC processing fee sync from Square Payouts API
- `server/services/intercardService.ts` — Intercard arcade revenue API client and sync
- `server/dateUtils.ts` — Eastern Time boundary calculations
- `shared/schema.ts` — Drizzle ORM schema (single source of truth for types)
- `client/src/pages/Admin.tsx` — admin panel with user management and sync controls
- `client/src/components/dashboard/Header.tsx` — header with last-synced indicator
- `server/middleware/rateLimiter.ts` — API, auth, and sync rate limiters
- `server/validateEnv.ts` — startup environment variable validation
- `client/src/components/ErrorBoundary.tsx` — React error boundary

## MCP Server (Claude Integration)
- **File**: `server/mcp.ts` — MCP routes mounted on the main Express app
- **Endpoint**: `https://<replit-domain>/mcp` (Streamable HTTP, same port as main app)
- **Health check**: `https://<replit-domain>/mcp/health`
- **Protocol**: Model Context Protocol (MCP) via `@modelcontextprotocol/sdk` (StreamableHTTPServerTransport)
- **Purpose**: Lets Claude Desktop / Claude cowork query the sales database directly
- **Architecture**: `registerMcpRoutes(app)` called in `server/index.ts` before session middleware; each MCP session gets its own McpServer instance + transport; sessions tracked by UUID with 30-min idle TTL and max 50 concurrent
- **Tools exposed** (22 total):
  - `get_daily_summary` — KPI overview (revenue, orders, avg order, period changes)
  - `get_detailed_breakdown` — full revenue category breakdown (tips, taxes, refunds, gift cards, Intercard, etc.)
  - `get_hourly_revenue` — revenue by hour of day (Eastern Time)
  - `get_category_revenue` — revenue by product category
  - `get_gift_card_summary` — gift card sold/redeemed/outstanding
  - `get_gift_card_breakdown` — bowling vs laser tag deposits vs true gift card sales
  - `get_top_selling_items` — top menu items by quantity sold
  - `get_intercard_revenue` — arcade kiosk cash/credit revenue
  - `get_processing_fees` — CC processing fee breakdown
  - `get_refunds_list` — individual refund records
  - `get_sync_status` — data sync timestamps and status
  - `get_database_stats` — record counts per table
  - `query_orders` — flexible order search with filters
  - `compare_periods` — side-by-side period comparison with % changes
  - `get_daily_revenue_trend` — daily revenue time series for trend analysis
  - `get_monthly_revenue_trend` — monthly gross/net revenue with refund totals (SQL-only, fast for full-year queries)
  - `get_revenue_by_day_of_week` — avg/total revenue by day of week for peak day analysis (SQL-only)
  - `get_revenue_by_source` — revenue by order source (Terminal, Web Reservation, etc.) with optional terminal grouping (SQL-only)
  - `get_monthly_order_stats` — monthly order count, avg order value, tax, discounts (SQL-only)
  - `get_hourly_heatmap` — revenue heatmap by day-of-week × hour-of-day (SQL-only)
  - `get_top_items_by_month` — top-selling items per month for seasonal trend tracking (SQL-only)
  - `run_read_query` — arbitrary read-only SQL for flexible BI analysis (READ ONLY transaction, write operations blocked)
- **All tools** share the same date range parameters: dateRange (today/yesterday/last7days/last30days/thisMonth/lastMonth/custom) + optional startDate/endDate for custom ranges
- **SQL-only tools** (Task #26): 7 new tools added that query PostgreSQL directly without going through service layers. These are optimized for Claude's BI analysis across any date range without timeout risk. The `run_read_query` tool provides full flexibility with safety guards (READ ONLY transaction + keyword blocklist).

## Security Hardening
- **Rate limiting**: All `/api` routes limited to 100 req/min; login limited to 10 attempts per 15 min; sync endpoints limited to 5 req/min
- **Auth on API routes**: All data-fetching routes require authenticated session (except `/api/health` and `/api/sync/status`)
- **Admin-only sync**: All sync/backfill POST endpoints require admin role
- **Error boundary**: React ErrorBoundary wraps the entire app to prevent white-screen crashes
- **Env validation**: Required env vars (`DATABASE_URL`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`) checked at startup; warning for missing `SESSION_SECRET`
- **Database indexes**: Indexes created at startup on all frequently-queried timestamp and ID columns
- **Health check**: `GET /api/health` returns `{ status: "ok", timestamp }` for monitoring
- **Session security**: httpOnly cookies, 30-day expiry, sameSite lax, PostgreSQL-backed session store
