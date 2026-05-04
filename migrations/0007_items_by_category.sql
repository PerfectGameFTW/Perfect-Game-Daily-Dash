-- Task #188: Items by Category dashboard tab.
--
-- Adds two columns the new Items tab depends on:
--   * square_categories.parent_category_id — mirrors Square's
--     category hierarchy. NULL means the row IS itself a top-level
--     rollup (e.g. "Food", "Beverage"); a non-null value points to
--     the rollup this category belongs to (e.g. Pizza → Food). The
--     items dashboard uses this to drive the rollup dropdowns
--     without any hand-maintained mapping. Populated on next
--     catalog sync from `categoryData.parentCategory.id`
--     (with legacy `parentCategoryId` fallback).
--   * square_catalog_items.is_archived — captures Square's
--     `is_deleted` flag so retired SKUs disappear from the items
--     dashboard without losing their historical sales data.
--     Defaults to false so existing rows render unchanged until the
--     next catalog sync corrects them.
--
-- Both columns are additive and default-safe; no backfill needed
-- for the app to start. The next scheduled / manual catalog sync
-- (server/services/catalogService.ts → syncCatalog) will populate
-- the real values for every row.

ALTER TABLE square_categories
  ADD COLUMN IF NOT EXISTS parent_category_id TEXT;

ALTER TABLE square_catalog_items
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;
