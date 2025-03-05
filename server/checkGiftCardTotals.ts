import { db } from './db';
import { sql } from 'drizzle-orm';
import { pgStorage } from './pgStorage';
import { DateRange } from '@shared/schema';

async function checkGiftCardTotals() {
  console.log('Checking gift card totals across all dates...');

  try {
    // Test multiple date ranges to ensure consistency
    const dateRanges: DateRange[] = [
      'today',
      'yesterday',
      'last7days',
      'thisMonth'
    ];

    // Create custom dates for March 2, 3, and 4
    const dates = [
      { name: 'March 2', date: new Date('2025-03-02T05:00:00.000Z') },
      { name: 'March 3', date: new Date('2025-03-03T05:00:00.000Z') },
      { name: 'March 4', date: new Date('2025-03-04T05:00:00.000Z') }
    ];

    // Check standard date ranges
    for (const range of dateRanges) {
      const amount = await pgStorage.getGiftCardSales(range);
      console.log(`${range}: $${amount}`);
    }

    // Check specific dates
    for (const { name, date } of dates) {
      const amount = await pgStorage.getGiftCardSales('custom', date, date);
      console.log(`${name}: $${amount}`);
    }

    // Verify March 4 specifically
    const march4 = await pgStorage.getGiftCardSales('custom', 
      new Date('2025-03-04T05:00:00.000Z'),
      new Date('2025-03-04T05:00:00.000Z'));
    console.log(`March 4 (specific check): $${march4}`);

    // Get actual gift card data for March 4
    console.log('\nMarch 4 gift cards:');
    const march4Cards = await db.execute(sql`
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
        id,
        square_id,
        amount,
        redeemed_amount,
        (amount + redeemed_amount) as original_amount
      FROM 
        gift_cards_et
      WHERE 
        DATE(purchase_date_et) = '2025-03-04'::date
      ORDER BY 
        id
    `);

    // Display individual card details
    for (const card of march4Cards.rows) {
      console.log(`Card ${card.square_id}: Current=${card.amount}, Redeemed=${card.redeemed_amount}, Original=${card.original_amount}`);
    }

    // Calculate total for March 4 cards
    const march4Total = march4Cards.rows.reduce((sum, card) => {
      return sum + Number(card.amount) + Number(card.redeemed_amount);
    }, 0);
    console.log(`Total for March 4 (direct calculation): $${march4Total}`);

  } catch (error) {
    console.error('Error checking gift card data:', error);
  }
}

// Execute the function
checkGiftCardTotals()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Failed to check gift card totals:', error);
    process.exit(1);
  });