/**
 * Script to fix all gift card activation amounts in the database
 * 
 * This script extracts the correct activation amounts from the Square API data
 * stored in the square_data JSON field and updates the activation_amount field.
 */

import { db } from './db';
import { sql } from 'drizzle-orm';
import { pool } from './db';

async function fixGiftCardActivationAmounts() {
  console.log('Starting gift card activation amount fix...');
  
  try {
    // First, let's get a count of gift cards that need fixing
    const countResult = await db.execute(sql`
      SELECT 
        COUNT(*) as total_cards,
        COUNT(CASE WHEN activation_amount = 0 OR activation_amount IS NULL THEN 1 END) as cards_to_fix
      FROM 
        gift_cards
    `);
    
    const totalCards = Number(countResult.rows[0]?.total_cards) || 0;
    const cardsToFix = Number(countResult.rows[0]?.cards_to_fix) || 0;
    
    console.log(`Total gift cards: ${totalCards}`);
    console.log(`Gift cards needing fixes: ${cardsToFix}`);
    
    // Get all gift cards that have square_data but zero or null activation_amount
    const giftCards = await db.execute(sql`
      SELECT 
        id, 
        square_id, 
        activation_amount,
        square_data
      FROM 
        gift_cards
      WHERE 
        square_data IS NOT NULL
      ORDER BY 
        id
    `);
    
    console.log(`Retrieved ${giftCards.rows.length} gift cards to process`);
    
    let updatedCount = 0;
    let errorCount = 0;
    let noChangeCount = 0;
    
    // Process each gift card
    for (const card of giftCards.rows) {
      try {
        const id = Number(card.id);
        const squareData = card.square_data;
        const currentActivationAmount = Number(card.activation_amount) || 0;
        
        // Extract the amount from Square data
        let newActivationAmount = extractAmountFromSquareData(squareData);
        
        // Skip if the activation amount is already correct
        if (newActivationAmount === currentActivationAmount) {
          noChangeCount++;
          continue;
        }
        
        // Only update if we found a valid amount that differs from the current value
        if (newActivationAmount !== null && newActivationAmount !== currentActivationAmount) {
          await db.execute(sql`
            UPDATE gift_cards
            SET activation_amount = ${newActivationAmount}
            WHERE id = ${id}
          `);
          
          console.log(`Updated gift card ID ${id} from ${currentActivationAmount} to ${newActivationAmount}`);
          updatedCount++;
        }
      } catch (error) {
        console.error(`Error processing gift card ${card.id}:`, error);
        errorCount++;
      }
    }
    
    console.log('Finished updating gift card activation amounts:');
    console.log(`Updated: ${updatedCount}`);
    console.log(`No changes needed: ${noChangeCount}`);
    console.log(`Errors: ${errorCount}`);
    
    // Verify the results for specific dates we care about
    await verifyResults();
    
    return {
      total: totalCards,
      updated: updatedCount,
      noChange: noChangeCount,
      errors: errorCount
    };
  } catch (error) {
    console.error('Error during gift card activation amount fix:', error);
    throw error;
  } finally {
    // Connection will be released back to the pool
  }
}

/**
 * Extract the amount from the Square data JSON
 * The amounts are stored in cents in the Square data
 */
function extractAmountFromSquareData(squareData: any): number | null {
  if (!squareData) return null;
  
  try {
    // Parse the data if it's a string
    const data = typeof squareData === 'string' ? JSON.parse(squareData) : squareData;
    
    // First, try to get from balanceMoney (most reliable source)
    if (data.balanceMoney && data.balanceMoney.amount) {
      const amountInCents = parseInt(data.balanceMoney.amount, 10);
      if (!isNaN(amountInCents)) {
        return amountInCents / 100; // Convert cents to dollars
      }
    }
    
    // If not found in balanceMoney, try ganMoney (if available)
    if (data.ganMoney && data.ganMoney.amount) {
      const amountInCents = parseInt(data.ganMoney.amount, 10);
      if (!isNaN(amountInCents)) {
        return amountInCents / 100; // Convert cents to dollars
      }
    }
    
    // If we get here, we couldn't find a valid amount
    return null;
  } catch (error) {
    console.error('Error extracting amount from Square data:', error);
    return null;
  }
}

/**
 * Verify the updated data for specific dates
 */
async function verifyResults() {
  console.log('\nVerifying results for key dates:');
  
  const datesToCheck = ['2025-03-02', '2025-03-03', '2025-03-04', '2025-03-05'];
  
  for (const dateStr of datesToCheck) {
    const result = await db.execute(sql`
      SELECT 
        to_char(purchase_date AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as date_et,
        COUNT(*) as card_count,
        COALESCE(SUM(activation_amount), 0) as activation_total
      FROM 
        gift_cards 
      WHERE 
        to_char(purchase_date AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') = ${dateStr}
      GROUP BY 
        date_et
    `);
    
    if (result.rows.length > 0) {
      const row = result.rows[0];
      console.log(`${row.date_et}: ${row.card_count} cards, $${row.activation_total.toFixed(2)} total activation`);
    } else {
      console.log(`${dateStr}: No gift cards found`);
    }
  }
}

// Export the function for use in routes
export { fixGiftCardActivationAmounts };

// If this script is run directly
if (require.main === module) {
  fixGiftCardActivationAmounts()
    .then(() => {
      console.log('Gift card activation amount fix completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('Error during gift card activation amount fix:', error);
      process.exit(1);
    });
}