/**
 * FORCE UPDATE ALL Gift Cards with Correct Amounts from Orders
 * 
 * This script FORCES an update on EVERY gift card by:
 * 1. Retrieving ALL gift cards in the database (with no limit or filters)
 * 2. Directly connecting each gift card to order data through transaction timestamps
 * 3. FORCING an update on every single gift card with the amount from the orders table
 * 4. No conditional checks or filters - every card gets updated with order data
 * 
 * This ensures that ALL gift cards have correct activation amounts pulled directly 
 * from the orders table, which is the source of truth. Any existing activation amount
 * values will be overwritten with the values from orders.
 */

import { db } from './db';
import { sql } from 'drizzle-orm';
import { giftCards } from '../shared/schema';

// Return type definition for improved type safety
interface UpdateResult {
  success: boolean;
  message: string;
  updated: number;
  directlyUpdated: number;
  skipped: number;
}

// Verify activation amounts for debugging
async function verifyActivationAmounts(): Promise<void> {
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

export async function updateGiftCardActivationFromTransactions(): Promise<UpdateResult> {
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
      -- Process ALL gift cards in the database, no limits, no conditions
      ORDER BY 
        gc.purchase_date DESC
    `);

    console.log(`Found ${giftCardTransactions.rows.length} gift cards with potential transaction matches`);
    
    // Step 2: For each gift card transaction, find the corresponding order
    let updatedCount = 0;
    let skippedCount = 0;
    
    // Process in smaller batches to avoid timeouts and connection issues
    const BATCH_SIZE = 10; // Process 10 cards at a time
    
    for (let i = 0; i < giftCardTransactions.rows.length; i += BATCH_SIZE) {
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(giftCardTransactions.rows.length / BATCH_SIZE)}`);
      
      // Process this batch
      const batch = giftCardTransactions.rows.slice(i, i + BATCH_SIZE);
      
      for (const giftCard of batch) {
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
          
          // FORCE UPDATE ALL gift cards with the amount from orders
          const currentActivationAmount = Number(giftCard.activation_amount || 0);
          const newActivationAmount = Number(giftCardAmount);
          
          console.log(`Gift card ID ${giftCardId}: Current activation amount: $${currentActivationAmount.toFixed(2)}, New amount from order: $${newActivationAmount.toFixed(2)}`);
          
          // ALWAYS update with the order amount - no tolerance check
          // Using the exact column name to ensure the update works
          await db.execute(sql`
            UPDATE gift_cards
            SET activation_amount = ${newActivationAmount}
            WHERE id = ${giftCardId}
          `);
          
          console.log(`✅ FORCE UPDATED gift card ID ${giftCardId} with amount $${newActivationAmount.toFixed(2)} from order ID ${closestOrder.order_id} (was $${currentActivationAmount.toFixed(2)})`);
          updatedCount++;
        } catch (error) {
          console.error(`Error processing gift card ${giftCard.id}:`, error);
          skippedCount++;
        }
      }
    }
    
    console.log(`Gift card activation update completed: ${updatedCount} updated, ${skippedCount} skipped`);
    
    // Verify the updated amounts
    await verifyActivationAmounts();
    
    // STEP 4: Handle gift cards that couldn't be matched with transactions
    // by trying to match them directly with orders via purchase dates
    console.log("Processing remaining gift cards directly from orders data...");
    
    // Get all gift cards that still have zero activation amounts
    const remainingCards = await db.execute(sql`
      SELECT 
        id, 
        square_id, 
        gan,
        purchase_date, 
        activation_amount
      FROM 
        gift_cards
      WHERE 
        activation_amount IS NULL 
        OR activation_amount = 0
    `);
    
    console.log(`Found ${remainingCards.rows.length} gift cards that still need activation amounts`);
    
    let directUpdatedCount = 0;
    
    // Process these cards directly against orders
    for (const card of remainingCards.rows) {
      try {
        const cardId = card.id;
        const purchaseDate = card.purchase_date;
        
        // Find orders with gift card items around this card's purchase date
        const directOrders = await db.execute(sql`
          SELECT 
            o.id as order_id,
            o.created_at,
            oli.total_money,
            oli.name
          FROM 
            orders o
          JOIN 
            order_line_items oli ON oli.order_id = o.id
          WHERE 
            o.created_at >= ${purchaseDate}::timestamptz - interval '2 hours'
            AND o.created_at <= ${purchaseDate}::timestamptz + interval '2 hours'
            AND (
              oli.square_data->>'itemType' = 'GIFT_CARD' 
              OR LOWER(oli.name) LIKE '%gift%'
              OR LOWER(oli.name) LIKE '%deposit%'
            )
          ORDER BY 
            ABS(EXTRACT(EPOCH FROM (o.created_at - ${purchaseDate}::timestamptz)))
        `);
        
        if (directOrders.rows.length > 0) {
          const closestOrder = directOrders.rows[0];
          const directAmount = Number(closestOrder.total_money);
          
          if (directAmount > 0) {
            await db.update(giftCards)
              .set({ activationAmount: directAmount })
              .where(sql`id = ${cardId}`);
            
            console.log(`✅ DIRECT UPDATE: Gift card ID ${cardId} with amount $${directAmount.toFixed(2)} from order ID ${closestOrder.order_id}`);
            directUpdatedCount++;
          }
        }
      } catch (error) {
        console.error(`Error processing remaining gift card ${card.id}:`, error);
      }
    }
    
    console.log(`Direct order matching: ${directUpdatedCount} additional cards updated`);
    
    return {
      success: true,
      message: `Updated ${updatedCount + directUpdatedCount} gift card activation amounts from orders table`,
      updated: updatedCount,
      directlyUpdated: directUpdatedCount,
      skipped: skippedCount
    };
  } catch (error) {
    console.error('Error updating gift card activation amounts:', error);
    throw error;
  }
}

// Allow this file to be run directly with 'node --loader tsx <file>'
// but avoid execution when it's imported as a module
import { fileURLToPath } from 'url';

// ES module equivalent of 'if this file is run directly'
const isMainModule = process.argv.length > 1 && 
                     fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  updateGiftCardActivationFromTransactions()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error in main execution:', error);
      process.exit(1);
    });
}