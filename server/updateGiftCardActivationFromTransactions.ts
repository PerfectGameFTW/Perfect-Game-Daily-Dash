/**
 * Connect Gift Card Transactions with Orders
 * 
 * This script updates gift card activation amounts by:
 * 1. Finding transactions in gift_cards_et view
 * 2. Matching them with corresponding orders
 * 3. Extracting the correct activation amount from the matched order
 * 4. Updating the gift_cards table with accurate activation_amount values
 * 
 * This approach ensures accurate gift card sales reporting by creating a direct
 * connection between transactions and orders for precise activation amounts.
 */

import { db } from './db';
import { sql } from 'drizzle-orm';
import { giftCards } from '../shared/schema';

export async function updateGiftCardActivationFromTransactions() {
  console.log('Starting gift card activation update from transactions...');
  
  try {
    // Step 1: Get all gift cards from the gift_cards_et view with their transactions
    const giftCardTransactions = await db.execute(sql`
      SELECT 
        gc.id,
        gc.square_id,
        gc.gan,
        gc.amount,
        gc.redeemed_amount,
        gc.activation_amount,
        gc.purchase_date,
        t.id as transaction_id,
        t.square_id as transaction_square_id,
        t.timestamp as transaction_timestamp,
        t.category_id as transaction_category
      FROM 
        gift_cards gc
      LEFT JOIN 
        transactions t ON t.timestamp >= gc.purchase_date - interval '1 hour'
                    AND t.timestamp <= gc.purchase_date + interval '1 hour'
      -- Removed the WHERE clause to check ALL gift cards
      ORDER BY 
        gc.purchase_date DESC
      LIMIT 100 -- Limit to 100 recent cards for testing
    `);

    console.log(`Found ${giftCardTransactions.rows.length} gift cards with potential transaction matches`);
    
    // Step 2: For each gift card transaction, find the corresponding order
    let updatedCount = 0;
    let skippedCount = 0;
    
    for (const giftCard of giftCardTransactions.rows) {
      try {
        const giftCardId = giftCard.id;
        const squareId = giftCard.square_id;
        const transactionId = giftCard.transaction_id;
        
        if (!transactionId) {
          console.log(`No transaction found for gift card ID ${giftCardId}`);
          skippedCount++;
          continue;
        }
        
        // Step 3: Find orders that match this transaction timing
        const matchingOrders = await db.execute(sql`
          SELECT 
            o.id as order_id,
            o.square_id as order_square_id,
            o.created_at as order_timestamp,
            o.total_money as order_total,
            oli.id as line_item_id,
            oli.name as item_name,
            oli.total_money as item_total,
            oli.square_data->>'itemType' as item_type
          FROM 
            orders o
          JOIN 
            order_line_items oli ON oli.order_id = o.id
          WHERE 
            o.created_at >= ${giftCard.transaction_timestamp}::timestamptz - interval '30 minutes'
            AND o.created_at <= ${giftCard.transaction_timestamp}::timestamptz + interval '30 minutes'
            AND (
              oli.square_data->>'itemType' = 'GIFT_CARD'
              OR LOWER(oli.name) LIKE '%gift%'
              OR LOWER(oli.name) LIKE '%deposit%'
            )
          ORDER BY 
            ABS(EXTRACT(EPOCH FROM (o.created_at - ${giftCard.transaction_timestamp}::timestamptz)))
        `);
        
        if (matchingOrders.rows.length === 0) {
          console.log(`No matching orders found for gift card ID ${giftCardId}`);
          skippedCount++;
          continue;
        }
        
        console.log(`Found ${matchingOrders.rows.length} potential matching orders for gift card ID ${giftCardId}`);
        
        // Use the closest matching order
        const closestOrder = matchingOrders.rows[0];
        const giftCardAmount = closestOrder.item_total || closestOrder.order_total;
        
        if (!giftCardAmount || isNaN(Number(giftCardAmount)) || Number(giftCardAmount) <= 0) {
          console.log(`Invalid gift card amount for gift card ID ${giftCardId}`);
          skippedCount++;
          continue;
        }
        
        // Only update if the found amount is significantly different from current activation amount
        const currentActivationAmount = Number(giftCard.activation_amount || 0);
        const newActivationAmount = Number(giftCardAmount);
        const difference = Math.abs(currentActivationAmount - newActivationAmount);
        const percentDifference = currentActivationAmount > 0 ? (difference / currentActivationAmount) * 100 : 100;
        
        console.log(`Gift card ID ${giftCardId}: Current activation amount: $${currentActivationAmount.toFixed(2)}, New amount: $${newActivationAmount.toFixed(2)}, Difference: ${percentDifference.toFixed(2)}%`);
        
        // Only update if difference is more than 10% and at least $5
        if (percentDifference > 10 && difference > 5) {
          await db.update(giftCards)
            .set({ activationAmount: newActivationAmount })
            .where(sql`id = ${giftCardId}`);
          
          console.log(`✅ Updated gift card ID ${giftCardId} with activation amount $${newActivationAmount.toFixed(2)} from order ID ${closestOrder.order_id} (was $${currentActivationAmount.toFixed(2)})`);
          updatedCount++;
        } else {
          console.log(`⏭️ Skipped update for gift card ID ${giftCardId} - difference too small (${percentDifference.toFixed(2)}%)`);
          skippedCount++;
        }
      } catch (error) {
        console.error(`Error processing gift card ${giftCard.id}:`, error);
        skippedCount++;
      }
    }
    
    console.log(`Gift card activation update completed: ${updatedCount} updated, ${skippedCount} skipped`);
    
    // Verify the updated amounts
    await verifyActivationAmounts();
    
    return {
      success: true,
      message: `Updated ${updatedCount} gift card activation amounts from transaction-order matching`,
      updated: updatedCount,
      skipped: skippedCount
    };
  } catch (error) {
    console.error('Error updating gift card activation amounts:', error);
    throw error;
  }
}

// Verify activation amounts for debugging
async function verifyActivationAmounts() {
  try {
    const result = await db.execute(sql`
      SELECT 
        DATE(purchase_date AT TIME ZONE 'America/New_York') as date, 
        COUNT(*) as card_count,
        SUM(activation_amount) as total_activation,
        SUM(amount) as total_current,
        SUM(redeemed_amount) as total_redeemed
      FROM 
        gift_cards
      GROUP BY 
        DATE(purchase_date AT TIME ZONE 'America/New_York')
      ORDER BY 
        date
    `);
    
    console.log('Gift Card Activation Amounts By Date:');
    for (const row of result.rows) {
      console.log(`${row.date}: ${row.card_count} cards, $${Number(row.total_activation).toFixed(2)} total activation`);
      console.log(`  Current Balance Total: $${Number(row.total_current).toFixed(2)}`);
      console.log(`  Redeemed Amount Total: $${Number(row.total_redeemed).toFixed(2)}`);
      const sum = Number(row.total_current) + Number(row.total_redeemed);
      console.log(`  Sum (Balance + Redeemed): $${sum.toFixed(2)}`);
      
      // Count cards with and without activation amount
      const detailedCount = await db.execute(sql`
        SELECT 
          COUNT(*) FILTER (WHERE activation_amount IS NOT NULL AND activation_amount > 0) as with_activation,
          COUNT(*) FILTER (WHERE activation_amount IS NULL OR activation_amount = 0) as without_activation
        FROM 
          gift_cards
        WHERE 
          DATE(purchase_date AT TIME ZONE 'America/New_York') = ${row.date}
      `);
      
      if (detailedCount.rows.length > 0) {
        console.log(`  Cards with activation amount: ${detailedCount.rows[0].with_activation}`);
        console.log(`  Cards missing activation amount: ${detailedCount.rows[0].without_activation}`);
      }
    }
  } catch (error) {
    console.error('Error verifying activation amounts:', error);
  }
}

// Allow this file to be run directly with 'node --loader tsx <file>'
// but avoid execution when it's imported as a module
import { fileURLToPath } from 'url';

// ES module equivalent of 'if this file is run directly'
const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  updateGiftCardActivationFromTransactions()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error in main execution:', error);
      process.exit(1);
    });
}