-- Add activation_amount field to gift_cards table
ALTER TABLE gift_cards ADD COLUMN activation_amount REAL;

-- Update the gift_cards_et view to include the new column
CREATE OR REPLACE VIEW gift_cards_et AS
  SELECT 
    id,
    square_id as squareId,
    amount,
    redeemed_amount as redeemedAmount,
    activation_amount as activationAmount,
    is_active as isActive,
    purchase_date,
    purchase_date AT TIME ZONE 'America/New_York' as purchase_date_et,
    square_data as squareData
  FROM 
    gift_cards;

-- Populate activation_amount based on current amount + redeemed_amount
-- This sets the initial values for existing gift cards in the database
UPDATE gift_cards
SET activation_amount = amount + redeemed_amount
WHERE activation_amount IS NULL;

-- Log the migration
INSERT INTO _drizzle_migrations (hash, created_at)
VALUES ('0002_add_activation_amount', NOW());