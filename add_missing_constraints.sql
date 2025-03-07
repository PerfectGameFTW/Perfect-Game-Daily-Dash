-- Script to add missing foreign key constraints to the payment tables
-- Created: March 7, 2025

-- First, check for and fix any invalid foreign key references
-- This avoids constraint violations when adding the constraints

-- 1. Fix payments.order_id references to non-existent orders (if any)
UPDATE payments 
SET order_id = NULL
WHERE order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM orders WHERE orders.id = payments.order_id
);

-- 2. Fix payments.gift_card_id references to non-existent gift cards (if any)
UPDATE payments 
SET gift_card_id = NULL
WHERE gift_card_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM gift_cards WHERE gift_cards.id = payments.gift_card_id
);

-- 3. Fix gift_cards.activation_payment_id references to non-existent payments (if any)
UPDATE gift_cards 
SET activation_payment_id = NULL
WHERE activation_payment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payments WHERE payments.id = gift_cards.activation_payment_id
);

-- Now add the missing foreign key constraints

-- 1. Add constraint for payments.order_id -> orders.id
ALTER TABLE payments
ADD CONSTRAINT payments_order_id_fkey
FOREIGN KEY (order_id) REFERENCES orders (id)
ON DELETE SET NULL;  -- If an order is deleted, we don't want to delete the payment

-- 2. Add constraint for payments.gift_card_id -> gift_cards.id
ALTER TABLE payments
ADD CONSTRAINT payments_gift_card_id_fkey
FOREIGN KEY (gift_card_id) REFERENCES gift_cards (id)
ON DELETE SET NULL;  -- If a gift card is deleted, we don't want to delete the payment

-- 3. Add constraint for gift_cards.activation_payment_id -> payments.id  
ALTER TABLE gift_cards
ADD CONSTRAINT gift_cards_activation_payment_id_fkey
FOREIGN KEY (activation_payment_id) REFERENCES payments (id)
ON DELETE SET NULL;  -- If a payment is deleted, we don't want to delete the gift card

-- 4. Add constraint for payment_sources.gift_card_id -> gift_cards.id
ALTER TABLE payment_sources
ADD CONSTRAINT payment_sources_gift_card_id_fkey
FOREIGN KEY (gift_card_id) REFERENCES gift_cards (id)
ON DELETE SET NULL;  -- If a gift card is deleted, set NULL for this reference

-- Add indexes to improve query performance on foreign key columns
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_gift_card_id ON payments(gift_card_id);
CREATE INDEX IF NOT EXISTS idx_payments_source_id ON payments(source_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_activation_payment_id ON gift_cards(activation_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_sources_gift_card_id ON payment_sources(gift_card_id);

-- Add additional useful indexes for common queries
CREATE INDEX IF NOT EXISTS idx_payments_timestamp ON payments(timestamp);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_is_gift_card_activation ON payments(is_gift_card_activation);