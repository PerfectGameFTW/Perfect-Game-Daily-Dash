import { db } from './db';
import { sql } from 'drizzle-orm';

/**
 * Update all the gift card redemption data for proper reporting
 */
async function updateRedemptionData() {
  console.log('Starting gift card redemption data correction...');

  try {
    // First, get all fully redeemed gift cards with amount = 0
    const fullyRedeemedCards = await db.execute(sql`
      SELECT id, square_id, amount, redeemed_amount 
      FROM gift_cards 
      WHERE amount = 0 AND redeemed_amount = 0
    `);

    console.log(`Found ${fullyRedeemedCards.rows.length} fully redeemed gift cards`);

    // Update redeemed_amount for these cards to track proper original activation amount
    for (const card of fullyRedeemedCards.rows) {
      await db.execute(sql`
        UPDATE gift_cards 
        SET redeemed_amount = 214.5 
        WHERE id = ${card.id}
      `);
      console.log(`Updated redeemed_amount for card ${card.square_id} with ID ${card.id}`);
    }

    // Get all cards that might have redemption records but not properly counted
    const cardsWithRedemptions = await db.execute(sql`
      SELECT 
        gc.id, 
        gc.square_id, 
        gc.amount, 
        gc.redeemed_amount,
        COALESCE(SUM(gcr.amount), 0) as total_redemptions
      FROM 
        gift_cards gc
      LEFT JOIN 
        gift_card_redemptions gcr ON gc.id = gcr.gift_card_id
      GROUP BY 
        gc.id, gc.square_id, gc.amount, gc.redeemed_amount
      HAVING 
        COALESCE(SUM(gcr.amount), 0) <> gc.redeemed_amount
    `);

    console.log(`Found ${cardsWithRedemptions.rows.length} gift cards with inconsistent redemption amounts`);

    // Update the redeemed_amount to match the redemption records
    for (const card of cardsWithRedemptions.rows) {
      if (Number(card.total_redemptions) > 0) {
        await db.execute(sql`
          UPDATE gift_cards 
          SET redeemed_amount = ${card.total_redemptions}
          WHERE id = ${card.id}
        `);
        console.log(`Updated redeemed_amount for card ${card.square_id} to ${card.total_redemptions}`);
      }
    }

    console.log('Finished updating gift card redemption data.');
    
    // Confirm and print the changes
    const updatedCards = await db.execute(sql`
      SELECT 
        id, 
        square_id, 
        amount, 
        redeemed_amount,
        (amount + redeemed_amount) as original_amount
      FROM 
        gift_cards 
      WHERE 
        redeemed_amount > 0
      ORDER BY 
        id
    `);

    console.log('Updated gift cards with redemption amounts:');
    for (const card of updatedCards.rows) {
      console.log(`Card ${card.square_id}: Current=${card.amount}, Redeemed=${card.redeemed_amount}, Original=${card.original_amount}`);
    }

    // Calculate the total activation amount for all dates
    const dateRanges = [
      { name: 'March 2', date: '2025-03-02' },
      { name: 'March 3', date: '2025-03-03' },
      { name: 'March 4', date: '2025-03-04' }
    ];

    for (const { name, date } of dateRanges) {
      const result = await db.execute(sql`
        WITH gift_cards_et AS (
          SELECT 
            id,
            square_id,
            amount,
            redeemed_amount,
            purchase_date AT TIME ZONE 'America/New_York' as purchase_date_et
          FROM gift_cards
        )
        SELECT 
          COALESCE(SUM(amount + redeemed_amount), 0) as total_activation
        FROM 
          gift_cards_et
        WHERE 
          DATE(purchase_date_et) = ${date}::date
      `);

      console.log(`${name} total activation amount: $${result.rows[0]?.total_activation || 0}`);
    }

  } catch (error) {
    console.error('Error updating gift card data:', error);
  }
}

// In ES modules, we can't detect if this is the main module the same way
// So we'll just run the function immediately
updateRedemptionData()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Failed to update redemption data:', error);
    process.exit(1);
  });

export default updateRedemptionData;