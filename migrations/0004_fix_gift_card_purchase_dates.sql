-- Migration 0004: Fix gift card purchase_date timezone offset (one-time)
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
-- IDEMPOTENCY GUARD:
-- After this migration runs, every affected row has updated_at = '2026-03-21 18:37:44+00'.
-- If re-run, the AND clause below excludes any row that was already corrected by this
-- migration (updated_at = migration timestamp), making it a no-op on re-execution.
-- Cards inserted after the code fix (2026-03-21) have correct UTC timestamps already
-- and have an updated_at after the guard timestamp, so they are also excluded.
--
-- FIRST APPLICATION: Applied to all 7,805 rows on 2026-03-21 at 18:37:44 UTC.

UPDATE gift_cards
SET
  purchase_date = (purchase_date AT TIME ZONE 'UTC')::timestamp AT TIME ZONE 'America/New_York',
  updated_at    = CURRENT_TIMESTAMP
WHERE
  -- Only rows that were last updated BEFORE this migration ran.
  -- After the migration, updated_at = '2026-03-21 18:37:44+00' so re-run is a no-op.
  updated_at < '2026-03-21 18:37:00+00';
