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
- `giftCards_incremental` — New gift card activations (every 60 seconds)
- `giftCards_historical` — One-time full backfill of all ACTIVATE events (completed)
- `giftCardRedemptions` — Gift card usage linked to transactions (every 60 seconds)
- `refunds` — Square refunds via the dedicated Refunds API (separate from payments)

### Scheduled Sync
`server/services/schedulerService.ts`:
- **Every 60 seconds**: Payments, orders, refunds (last 15 min window), gift card incremental sync, gift card redemption sync, REDEEM activity balance monitor, Intercard today sync
- **Nightly at 3 AM ET**: Deep sync with 3-day lookback for payments/orders/refunds, catalog sync + backfill, payout fee sync, full gift card balance refresh (includes zeroing deleted cards)
- **On startup**: Historical backfill loops (gift cards, orders/payments, Intercard) run once in background if not already complete

### Gift Card Sync (Current Architecture)
The old `syncGiftCards()` method (which used `listGiftCards` API) has been **removed** — it was deprecated and prone to getting stuck because Square's listGiftCards has no date filter and lost pagination progress on server restart.

Two sync methods now handle all gift card data:

1. **Historical Backfill** (`syncGiftCardsHistoricalBackfill`):
   - One-time full scan of ALL Square ACTIVATE events (oldest-first via Activities API)
   - Resumable: saves cursor checkpoint after every page; restarts resume mid-scan
   - Processes up to 20 pages (1,000 events) per call; `runBackfillUntilComplete()` loops until done
   - Completed: 32,279 events processed (sync_state `giftCards_historical`, `is_complete=true`)
   - Has a 3-minute stale lock timeout — if stuck `in_progress` for >3 min, auto-resets

2. **Incremental Sync** (`syncIncrementalGiftCards`):
   - Runs every 60 seconds via scheduler
   - Fetches only ACTIVATE events newer than the last watermark (with 2-minute overlap buffer)
   - For each new activation: looks up or creates the gift card record, links the activation order ID
   - **Stale lock safeguard**: If the sync has been stuck `in_progress` for >10 minutes, it force-resets with a warning log (`⚠️ STALE LOCK DETECTED`) and allows the next cycle to proceed
   - **Deleted card fallback**: If Square returns 404 for a card (fully redeemed and removed), creates a basic record from the ACTIVATE event data (squareId, activation amount, order ID) instead of skipping — ensures short-lived web reservation deposit cards are still tracked

### REDEEM Activity Balance Monitor (Task #35)
- **Purpose**: Keeps gift card balances (Total Outstanding Value, Web Res Adv Deposits) accurate in near real-time instead of only during the nightly refresh
- **Mechanism**: Every 60 seconds, fetches REDEEM events from Square's Activities API since the last watermark (with 2-min overlap). For each redeemed card, fetches its current balance from Square and updates the DB. Uses sync_state key `giftCard_redeem_monitor`.
- **API efficiency**: Only 1-2 API calls per cycle (activity page fetch) plus 1 call per redeemed card — not the 8,000+ card full scan
- **Nightly deleted-card cleanup**: The nightly `refreshAllGiftCardBalances` now also zeroes out cards in the DB that no longer appear in Square's `listGiftCards` response (deleted/fully-redeemed cards)

### Stale Lock Safeguard (applies to all sync types with concurrency guards)
- **Problem**: If the server crashes or restarts while a sync is `in_progress`, the concurrency guard blocks all future runs indefinitely
- **Fix**: Both `syncIncrementalGiftCards` (10-min timeout) and `syncGiftCardsHistoricalBackfill` (3-min timeout) check elapsed time since `lastSyncedAt` and force-reset if the lock is stale
- **Alert**: When a stale lock is detected, a `console.warn` is emitted with the duration, making it visible in server logs

### Historical Catch-up
`POST /api/sync/historical` — starts a background process that chunks through monthly date ranges from a given start date through today, syncing orders, payments, and refunds for each chunk, then runs a full gift card sync and activation backfill.

### Gift Card Historical Backfill Endpoint (Task #4 fix)
`POST /api/sync/gift-cards-backfill` — triggers the Activities-API-based historical backfill described above. Call repeatedly until `finished: true` is returned. This fixed the March 9-20 gap where 228 cards were missed.

## Gift Card Activation Amounts
Fixed in Task #1. Root cause was that `activation_amount` was being set from current balance (wrong for spent cards). Now uses Square Gift Card Activities API (`ACTIVATE` events) as the authoritative source.

Key function: `server/squareClient.ts → fetchGiftCardActivitiesMap()` — returns `Map<squareId, amountDollars>`.

Repair/backfill: `server/services/enhancedGiftCardFix.ts → backfillGiftCardActivationAmounts()`.

## Bugs Fixed in Task #4 (March 9-20 gift card data gap)
1. **Bug 1 (PRIMARY)**: `syncGiftCards()` used `listGiftCards` API with no cursor checkpoint — server restarts lost pagination progress, leaving March 9-20 cards unreachable. Fixed by adding `syncGiftCardsHistoricalBackfill()` using Activities API with saved cursor. The old `syncGiftCards()` has since been fully removed.
2. **Bug 2 (field name)**: `syncService.ts` was setting `currentBalance` instead of `amount` in nightly full sync updates (silent no-op since `currentBalance` doesn't exist in schema). Fixed to use `amount`.
3. **Bug 3 (timezone)**: `convertSquareGiftCardToGiftCard()` called `toZonedTime()` which stored Eastern local time with UTC label (off by 4-5 hours). Fixed to store raw UTC directly from Square's `createdAt`. Historical backfill re-writes existing records with correct UTC timestamps.
4. **Bug 4 (schema drift)**: `activation_payment_id` column existed in DB but not in Drizzle schema. Added `activationPaymentId: integer("activation_payment_id")` to `shared/schema.ts`.

## Bugs Fixed: Gift Card Sync Stuck Locks (March 2026)
1. **Incremental sync frozen**: `giftCards_incremental` was stuck `in_progress` since March 23 due to a server crash mid-sync. The concurrency guard had no timeout, blocking all future runs indefinitely. Fixed by adding a 10-minute stale lock timeout with `console.warn` alert.
2. **Gift card redemption misclassification**: 8 of 9 redemptions were showing as "Gift Card Redemptions" instead of "Bowling Deposit Redemptions" because the incremental sync was frozen and those cards were never synced to the DB. The classification pipeline's DB lookup (tier 1) couldn't find them, so it fell back to the ACTIVATE API (tier 2) which correctly classified them — but the root cause was the missing DB records.
3. **Deleted card gap**: When Square deletes a fully-redeemed gift card, `fetchGiftCardById` returns 404 and the incremental sync silently skipped it, leaving no DB record. Fixed to create a basic record from the ACTIVATE event data (squareId, activation amount, order ID) so classification still works.
4. **Deprecated syncGiftCards removed**: The old `syncGiftCards()` method (~150 lines) and its stuck DB record (`giftCards` sync_state, frozen at 2400/8032 since March 21) were fully removed. All gift card sync now flows through `syncGiftCardsHistoricalBackfill` (completed) and `syncIncrementalGiftCards` (60-second cycle).

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

## Square Catalog Category Integration (Task #28)
Item categories are now pulled directly from Square's Catalog API instead of being guessed from item names.
- **DB tables**: `square_categories` (caches category ID→name), `square_catalog_items` (maps catalog object IDs and item variations to their category)
- **Service**: `server/services/catalogService.ts` — `syncCatalog()` fetches all CATEGORY and ITEM objects from Square, `backfillCategories()` re-categorizes existing records, `lookupCategorySync()` provides synchronous in-memory lookups
- **Sync integration**: Catalog is synced at the start of each order sync cycle; the in-memory cache is preloaded before payment syncs
- **Category assignment**: `convertSquareLineItemToOrderLineItem` and `convertSquarePaymentToTransaction` now check the catalog cache first, falling back to the old heuristic (`mapSquareCategory`) only when no catalog match exists
- **Category type**: `categorySchema` is now `z.string()` (was `z.enum`) so any Square category name is accepted
- **API endpoints**: `POST /api/sync/catalog` (sync catalog only), `POST /api/sync/catalog/backfill` (sync + backfill existing records)
- **Auto-update**: When items are moved between categories in Square, the next sync picks up the changes automatically

## Important Files
- `server/squareClient.ts` — Square API client, all fetch functions
- `server/services/syncService.ts` — orchestrates syncs, manages sync_state table
- `server/services/schedulerService.ts` — nightly cron scheduler
- `server/services/giftCardService.ts` — gift card DB queries, summary logic
- `server/services/enhancedGiftCardFix.ts` — activation amount backfill
- `server/services/payoutService.ts` — CC processing fee sync from Square Payouts API
- `server/services/intercardService.ts` — Intercard arcade revenue API client and sync
- `server/services/catalogService.ts` — Square Catalog API sync, category cache, and backfill
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

## Admin Bootstrap (first admin user)
The HTTP `POST /api/auth/register` endpoint is **admin-only**. An unauthenticated caller cannot create any account, including the very first one — the old "if the users table is empty, anyone can register as admin" path has been removed.

To create the first admin on a fresh database, run the bootstrap script out-of-band:

```bash
INITIAL_ADMIN_USERNAME=alice INITIAL_ADMIN_PASSWORD='strong-password' \
  tsx scripts/bootstrap-admin.ts
# or:
tsx scripts/bootstrap-admin.ts <username> <password>
```

The script wraps a check-and-insert in a transaction guarded by a Postgres advisory lock (`pg_advisory_xact_lock`), so concurrent invocations cannot both succeed — at most one admin is ever created. If an admin already exists the script refuses to create another one; create additional users via the admin UI (which calls `POST /api/auth/register` with a logged-in admin session).

The public registration path no longer exists. The admin-create schema (`adminCreateUserSchema` in `shared/schema.ts`) is the only way `role` can be set, and it is server-side validated; values from the request body are otherwise ignored / coerced to `'user'`.

## Running the Test Suite
The vitest suite under `server/tests/` writes to real tables (`orders`, `users`, `password_reset_tokens`, …) and grants real Postgres roles (`mcp_read_only`). To prevent any test-driven mutation from touching production data, the suite is wired to run against a separate **test database**, never against the live `DATABASE_URL` (Task #106).

- `server/tests/setup.ts` is loaded by vitest before any test file. It resolves the test connection string from `TEST_DATABASE_URL` (operator override) or, if unset, derives it by appending `_test` to the database-name segment of `DATABASE_URL` (e.g. `…/neondb` → `…/neondb_test`). It then rewrites `process.env.DATABASE_URL` so every `import { db } from '../db'` connects to the test target. If no test URL can be resolved — or if the resolved URL equals the live one — the setup throws and no test runs.
- `server/tests/globalSetup.ts` runs ONCE per `vitest run` in the main process, before any worker is spawned. It (1) acquires a Postgres session-scoped advisory lock on the test DB and holds it for the entire run, then (2) `TRUNCATE`s every public table so orphan rows from prior aborted runs can't leak across CI invocations.
- `scripts/ensure-test-db.ts` provisions the sibling database (`CREATE DATABASE`) idempotently and prints the resolved test URL on stdout.
- `scripts/post-merge.sh` runs the helper, pushes the schema into the test DB, and then runs `vitest run` with the test URL exported.

**Concurrent runs serialize, they do not isolate** (Task #139). Two `vitest run` invocations targeting the same Postgres host (e.g. a developer running `npm test` while CI's post-merge hook is mid-flight, or two post-merge hooks firing back-to-back) would otherwise truncate each other's fixtures partway through. `globalSetup.ts` prevents this by acquiring a fixed advisory lock on the test DB before truncating; the second invocation blocks at globalSetup until the first run's teardown releases the lock. The lock-holding session is heartbeated every 30s so an idle-timeout reaper cannot silently drop the lock mid-suite, and the wait is bounded at 15 minutes via Postgres `lock_timeout` so a stuck previous run surfaces a clear error instead of hanging the post-merge hook indefinitely. Runs do NOT each get their own ephemeral database — expect the second concurrent run to spend extra time waiting at startup.

To run the suite locally:

```bash
# One-time provisioning of the sibling database (idempotent).
TEST_DATABASE_URL=$(npx tsx scripts/ensure-test-db.ts)
export TEST_DATABASE_URL
DATABASE_URL=$TEST_DATABASE_URL npm run db:push -- --force

# Then run tests as usual; setup.ts will redirect db.ts at $TEST_DATABASE_URL.
npx vitest run
```

Setting `TEST_DATABASE_URL` to a connection string on a different host/cluster is also supported and skips the `_test` suffix derivation.

## Auth Policy
- **Password strength (creation/change)**: New passwords (registration, admin-create, password reset) must be 12-128 characters and contain at least one letter and one digit. Login intentionally allows shorter legacy passwords through so existing accounts can still sign in and rotate via the reset flow. Schema lives in `shared/schema.ts → strongPasswordSchema`.
- **Per-account lockout**: `users` table carries `failed_login_count` and `locked_until`. After 5 consecutive failed password attempts on the same username, the account is locked for 15 minutes regardless of source IP — defeats IP-rotating credential-stuffing botnets that the per-IP rate limiter cannot stop. A successful login resets the counter and clears the lock. Counter increment + threshold check happen in a single atomic UPDATE.
- **Lockout is unobservable**: A locked account returns the same 401 / `Invalid username or password` body as a wrong password, and `loginUser` always runs exactly one `bcrypt.compare` (against either the real hash or a constant dummy hash) so the three failure paths — unknown user, locked account, wrong password — are indistinguishable by status, body, and wall-clock time.
- **Session fixation**: Login regenerates the session ID before any authenticated state is attached (`req.session.regenerate`), invalidating any cookie planted before login.
- **Email-verified password reset**: The reset flow has two steps. (1) `POST /api/auth/request-reset` accepts a username or email and ALWAYS returns the same generic 200 message — it never reveals whether the account exists. The actual lookup/token-issue/email-send work runs **asynchronously** (`setImmediate` fire-and-forget) so HTTP response latency is constant regardless of outcome and cannot be used as an enumeration oracle. If the account exists and has a recovery email on file, a single-use 256-bit token is generated, its SHA-256 hash stored with a 30-minute expiry, and the raw token is delivered by email. Issuing a new link invalidates any prior unused token for that user. Rate-limited at 3 requests/IP/hour to protect the outbound email channel. (2) `POST /api/auth/complete-reset` redeems `{ token, newPassword }` inside a single transaction (mark used + update password) so the same token can never be redeemed twice. Successful reset also clears any active lockout.
- **Reset link base URL is operator-pinned, not Host-header derived**: In production (`NODE_ENV=production`) `APP_BASE_URL` MUST be set; otherwise the email is suppressed (with an operator alarm in the log) rather than constructed from a potentially attacker-supplied `Host` header — which would let an attacker phish a victim's reset token by poisoning the link domain. In dev the request host is used as a convenience fallback. Email delivery uses the Replit Gmail integration: `server/services/emailService.ts` fetches a short-lived OAuth access token from the connectors API on every send and POSTs the message to the Gmail REST API (`users.messages.send`). The Workspace user that completed OAuth must own (or have a verified "send mail as" alias for) the From address — by default `info@myperfectgame.com`, overridable via `MAIL_FROM_EMAIL`. `MAIL_FROM_NAME` controls the display name. In production the email service throws if the Gmail connector is not wired (no silent drops); in dev, with no connector available, the message body is written to a developer-only file under `os.tmpdir()/pg-dev-emails` so the reset flow stays testable without real email infrastructure. The connector lookup distinguishes two failure modes (Task #150): "Gmail not configured" (env vars absent / connection has no token) vs. "Gmail connector API unavailable" (connectors API returned non-2xx, dropped the connection, or sent malformed JSON). Each surfaces a distinct production error message and the connector-API-down case emits a structured `emailService.connector_fetch_failed` log line carrying the HTTP `status` so on-call can grep failures by code without re-running the request. The Gmail connector OAuth was completed against the Workspace account that owns `info@myperfectgame.com` and a real send-as smoke test against the live Gmail API confirmed the alias is accepted (Task #144).
- **Outbound-email failure alerting and audit log** (Task #104, `server/services/emailAlert.ts`): every blocked send emits a structured `emailService.send_failed` log line carrying a stable `reason` tag (`gmail_send_failed_<status>`, `gmail_network_error`, `connector_failed_<status>` or bare `connector_failed` when the connectors API didn't even return a status, `unconfigured`, `header_injection`), the HTTP `status` where applicable, and a `recipientHash` (12-hex-char SHA-256 prefix of the lowercased recipient address) so repeated failures to the same inbox aggregate visibly without writing the literal address to disk. Successful sends emit `emailService.send_succeeded` with the same `recipientHash` plus the Gmail-returned `gmailMessageId` so a "user reports never receiving the email" investigation can be correlated with Gmail's own audit trail. On top of that audit log, an in-process alerter keeps a rolling window of recent failures and POSTs a Slack-compatible webhook when the count crosses a threshold — defaults are tighter than the 5xx server alerter (3 failures in 15 minutes, 15-minute cooldown) because each lost transactional email is one locked-out user, not one HTTP request the client can retry. The alert text aggregates by `reason` so on-call sees `gmail_send_failed_403=4, connector_failed_503=1` instead of just "lots of failures" and knows whether to reconnect Gmail, wait out a Replit incident, or escalate to Google. Off by default — `EMAIL_ALERT_WEBHOOK_URL` must be set to enable it (`EMAIL_ALERT_THRESHOLD`, `EMAIL_ALERT_WINDOW_MS`, `EMAIL_ALERT_COOLDOWN_MS` override the defaults). The dev-stub fallback in non-production is treated as a successful delivery and does NOT feed the alerter, so a connectors-API outage in dev will not generate noise.

## Security Hardening
- **Rate limiting**: All `/api` routes limited to 100 req/min; login limited to 10 attempts per 15 min; sync endpoints limited to 5 req/min
- **Auth on API routes**: All data-fetching routes require authenticated session (except `/api/health` and `/api/sync/status`)
- **Admin-only sync**: All sync/backfill POST endpoints require admin role
- **Error boundary**: React ErrorBoundary wraps the entire app to prevent white-screen crashes
- **Env validation**: Required env vars (`DATABASE_URL`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`) checked at startup; warning for missing `SESSION_SECRET`
- **Database indexes**: Indexes created at startup on all frequently-queried timestamp and ID columns
- **Health check**: `GET /api/health` returns `{ status: "ok", timestamp }` for monitoring
- **Session security**: httpOnly cookies, 30-day expiry, sameSite lax, PostgreSQL-backed session store

## Observability: Logging Strategy (Task #82 / #114)
The structured logger (`server/logger.ts`) emits one JSON line per event to `process.stdout` / `process.stderr`. The Replit workspace log pane is the **single source of truth** for operator log review.

### Deliberate decision: no external log shipping (Task #114)
The in-process plumbing for forwarding logs to a hosted backend (Better Stack / Logtail / Axiom / etc.) and the in-process 5xx webhook alerter both exist in code (`server/services/logShipper.ts`, `server/services/serverErrorAlert.ts`) but are **intentionally left unwired**. The owner explicitly chose not to send logs or 5xx alerts to any third-party service — the workspace log pane is sufficient for current operational needs.

Both subsystems are designed as **opt-in no-ops**: when their env vars (`LOG_SHIPPER_URL`, `SERVER_ERROR_ALERT_WEBHOOK_URL`) are unset they short-circuit at startup and add zero overhead. Nothing leaves the process. They are kept in the codebase so that if the operational picture changes later (e.g. multiple operators, longer log retention needs, off-hours paging requirements), wiring them up is a pure config change — set env vars, redeploy, done — with no code changes required.

If a future operator decides to enable either:
- **Log shipping**: set production env vars `LOG_SHIPPER_URL` and `LOG_SHIPPER_TOKEN` (any HTTP-ingest backend that takes a Bearer-token POST works — Better Stack's free tier is the recommended low-friction option). Optional tunables: `LOG_SHIPPER_BATCH_SIZE` (50), `LOG_SHIPPER_FLUSH_MS` (2000), `LOG_SHIPPER_BUFFER_MAX` (1000), `LOG_SHIPPER_REQUEST_TIMEOUT_MS` (5000).
- **5xx webhook alerting**: set production env var `SERVER_ERROR_ALERT_WEBHOOK_URL` (any incoming-webhook URL accepting a `{ text }` JSON body — Slack, Discord, Mattermost, generic). Optional tunables: `SERVER_ERROR_ALERT_THRESHOLD` (5), `SERVER_ERROR_ALERT_WINDOW_MS` (5 min), `SERVER_ERROR_ALERT_COOLDOWN_MS` (15 min).
- **`app_settings` invalid-row alerting** (Task #122, `server/services/appSettingsInvalidRowAlert.ts`): set production env var `APP_SETTINGS_INVALID_ROW_ALERT_WEBHOOK_URL` (same Slack-compatible `{ text }` body). Fires when a persisted `app_settings` row fails its registered zod schema in `pgStorage.getAppSetting` — the storage layer already returns `undefined` and falls back to defaults, but without the alert a misconfigured production setting can silently revert until an incident. Per-key cooldown (default 1 hour, override via `APP_SETTINGS_INVALID_ROW_ALERT_COOLDOWN_MS`) keeps a hot bad row from paging on every poll while still letting a *different* broken key fire immediately. Payload includes the offending key + the first five zod issues + a runbook hint.

The shipper is hardened to never call the structured logger from its own failure path (would amplify outages) — failures land on stderr as `log_shipper.flush_failed` / `log_shipper.dropped` lines. The 5xx alerter has a rolling window with cooldown to prevent paging storms. All three are covered by unit tests at `server/tests/logShipper.test.ts`, `server/tests/serverErrorAlert.test.ts`, and `server/tests/appSettingsInvalidRowAlert.test.ts` (with a wiring assertion in `server/tests/appSettingsTyped.test.ts`).

#### Runbook: `app_settings invalid row` alert
When an alert fires, do **not** fix the row by editing it directly in psql — that's exactly the class of change that produces this alert. Either:
1. Ship a one-off migration that rewrites the row to the new shape (if the schema change was intentional and a default exists), or
2. Ship a one-off migration that deletes the row entirely so the consumer's hard-coded default takes over.

Hand edits in production leave no audit trail and re-create the same silent-drift problem the alerter exists to catch.
