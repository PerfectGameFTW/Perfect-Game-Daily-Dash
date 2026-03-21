-- Migration 0004: Fix gift card purchase_date timezone offset
--
-- BUG: convertSquareGiftCardToGiftCard() was calling toZonedTime(utcDate, 'America/New_York')
-- which returns a JS Date whose internal UTC value is shifted to the Eastern local time.
-- Example: A card activated at 18:07 UTC (EDT, -4h) was stored as 14:07+00 (wrong; off by 4h).
--
-- FIX: Treat the stored value as if it were Eastern local time and convert it to true UTC.
-- (purchase_date AT TIME ZONE 'UTC') extracts the stored value as a plain timestamp,
-- then AT TIME ZONE 'America/New_York' interprets that as ET and returns correct UTC.
-- This correctly handles both EST (-5h) and EDT (-4h) cards.
--
-- This migration is safe to run even after the Activities API backfill has corrected some
-- records — but the backfill should be run after this migration to ensure authoritative
-- activation amounts and the most accurate purchase dates from Square.

UPDATE gift_cards
SET
  purchase_date = (purchase_date AT TIME ZONE 'UTC')::timestamp AT TIME ZONE 'America/New_York',
  updated_at    = CURRENT_TIMESTAMP;

