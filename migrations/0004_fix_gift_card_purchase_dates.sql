-- Migration 0004: Fix gift card purchase_date timezone offset (run ONCE)
--
-- BUG: convertSquareGiftCardToGiftCard() was calling toZonedTime(utcDate, 'America/New_York')
-- which returns a JS Date whose internal UTC value is the Eastern local time.
-- Example: A card activated at 18:07 UTC (EDT, -4h) was stored as 14:07+00 (off by 4h).
--
-- FIX: Treat the stored value as if it were Eastern local time and find the correct UTC.
-- (purchase_date AT TIME ZONE 'UTC')::timestamp strips the timezone label, leaving the
-- raw Eastern wall-clock time.  AT TIME ZONE 'America/New_York' converts it back to
-- the correct UTC instant, handling DST (EST -5h / EDT -4h) automatically.
--
-- SCOPE GUARD (data-shape-based):
-- Only correct rows where created_at is before 2026-03-21T18:00Z — the timestamp when
-- the buggy convertSquareGiftCardToGiftCard() code was replaced with the correct UTC path.
-- Any card with created_at >= this value was inserted by the fixed code and already
-- holds the correct UTC purchase_date.
--
-- ONE-TIME EXECUTION: This migration must be run exactly once. Re-running it would
-- apply the AT TIME ZONE shift again to already-corrected rows (double-shifting).
-- Track via your migration runner (e.g., Flyway, Liquibase, or a migrations table).
-- If your environment has no migration tracker, check the applied state before running:
--   SELECT COUNT(*) FROM gift_cards
--   WHERE created_at < '2026-03-21 18:00:00+00'
--     AND purchase_date > NOW() - INTERVAL '7 days';  -- should be 0 if already applied
--
-- ALREADY APPLIED: Run on 2026-03-21 against 7,805 rows. Confirmed correct output:
--   ET 14:07 stored as UTC 14:07+00 → corrected to UTC 18:07+00 (EDT offset +4h).

UPDATE gift_cards
SET
  purchase_date = (purchase_date AT TIME ZONE 'UTC')::timestamp AT TIME ZONE 'America/New_York',
  updated_at    = CURRENT_TIMESTAMP
WHERE
  -- Scope to rows inserted before the code fix deployment.
  -- Rows with created_at >= this timestamp already have correct UTC purchase_dates.
  created_at < '2026-03-21 18:00:00+00';
