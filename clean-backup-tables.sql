-- Script to clean up backup tables from the database after successful migration
-- Created on March 6, 2025

-- Create a function that conditionally drops tables if they exist
CREATE OR REPLACE FUNCTION drop_table_if_exists(table_name text) RETURNS void AS $$
BEGIN
    EXECUTE 'DROP TABLE IF EXISTS ' || table_name || ' CASCADE';
    RAISE NOTICE 'Dropped table %', table_name;
EXCEPTION
    WHEN OTHERS THEN
    RAISE NOTICE 'Failed to drop %: %', table_name, SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- Drop backup tables with timestamp
SELECT drop_table_if_exists('sync_state_backup_2025_03_06T07_17_17_301Z');
SELECT drop_table_if_exists('orders_backup_2025_03_06T07_17_17_435Z');
SELECT drop_table_if_exists('users_backup_2025_03_06T07_17_13_159Z');
SELECT drop_table_if_exists('transactions_backup_2025_03_06T07_17_16_305Z');
SELECT drop_table_if_exists('gift_cards_backup_2025_03_06T07_17_16_990Z');
SELECT drop_table_if_exists('gift_card_redemptions_backup_2025_03_06T07_17_17_168Z');
SELECT drop_table_if_exists('order_line_items_backup_2025_03_06T07_17_17_589Z');
SELECT drop_table_if_exists('order_modifiers_backup_2025_03_06T07_17_17_750Z');
SELECT drop_table_if_exists('order_discounts_backup_2025_03_06T07_17_17_886Z');
SELECT drop_table_if_exists('users_backup_2025_03_06T07_21_53_808Z');
SELECT drop_table_if_exists('transactions_backup_2025_03_06T07_21_54_265Z');
SELECT drop_table_if_exists('gift_cards_backup_2025_03_06T07_21_54_606Z');
SELECT drop_table_if_exists('gift_card_redemptions_backup_2025_03_06T07_21_54_741Z');
SELECT drop_table_if_exists('sync_state_backup_2025_03_06T07_21_54_867Z');
SELECT drop_table_if_exists('orders_backup_2025_03_06T07_21_54_995Z');
SELECT drop_table_if_exists('order_line_items_backup_2025_03_06T07_21_55_138Z');
SELECT drop_table_if_exists('order_modifiers_backup_2025_03_06T07_21_55_270Z');
SELECT drop_table_if_exists('order_discounts_backup_2025_03_06T07_21_55_397Z');

-- Drop simple backup tables
SELECT drop_table_if_exists('transactions_backup');
SELECT drop_table_if_exists('gift_cards_backup');
SELECT drop_table_if_exists('gift_card_redemptions_backup');
SELECT drop_table_if_exists('orders_backup');

-- Drop the temporary function
DROP FUNCTION IF EXISTS drop_table_if_exists;

-- Provide a completion message
DO $$
BEGIN
    RAISE NOTICE 'Backup table cleanup complete.';
END $$;