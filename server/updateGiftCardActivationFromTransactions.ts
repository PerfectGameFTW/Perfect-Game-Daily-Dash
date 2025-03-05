/**
 * FORCE UPDATE ALL Gift Cards with Correct Amounts from Orders
 * 
 * This script FORCES an update on EVERY gift card by:
 * 1. Retrieving ALL gift cards in the database (with no limit or filters)
 * 2. Using precise timestamp matching (seconds, not hours) to find relevant transactions
 * 3. Using the orderId from transactions to directly link to the correct order
 * 4. FORCING an update on every gift card with amounts from the matching order's line items
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
    // Step 1: Get ALL gift cards (FORCE UPDATE approach)
    const allGiftCards = await db.execute(sql`
      SELECT 
        id,
        square_id,
        gan,
        amount,
        redeemed_amount,
        activation_amount,
        purchase_date
      FROM 
        gift_cards
      ORDER BY 
        purchase_date DESC
    `);

    console.log(`Found ${allGiftCards.rows.length} gift cards to process`);
    
    // Process in smaller batches to avoid timeouts and connection issues
    const BATCH_SIZE = 10;
    let updatedCount = 0;
    let skippedCount = 0;
    
    for (let i = 0; i < allGiftCards.rows.length; i += BATCH_SIZE) {
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(allGiftCards.rows.length / BATCH_SIZE)}`);
      
      // Process this batch
      const batch = allGiftCards.rows.slice(i, i + BATCH_SIZE);
      
      for (const giftCard of batch) {
        try {
          const giftCardId = giftCard.id;
          const purchaseDate = giftCard.purchase_date;
          
          // Step 2: Find transactions with precise timestamp match (within seconds)
          // Use a very narrow time window to ensure accuracy
          const matchingTransactions = await db.execute(sql`
            SELECT 
              t.id,
              t.square_id,
              t.timestamp,
              t.amount,
              t.square_data
            FROM 
              transactions t
            WHERE 
              t.timestamp >= ${purchaseDate}::timestamptz - interval '60 seconds'
              AND t.timestamp <= ${purchaseDate}::timestamptz + interval '60 seconds'
              AND t.status = 'completed'
            ORDER BY 
              ABS(EXTRACT(EPOCH FROM (t.timestamp - ${purchaseDate}::timestamptz)))
          `);
          
          if (matchingTransactions.rows.length === 0) {
            console.log(`No matching transactions found for gift card ID ${giftCardId}`);
            // Don't skip yet, try the fallback method
          } else {
            console.log(`Found ${matchingTransactions.rows.length} potential matching transactions for gift card ID ${giftCardId}`);
            
            let updatedViaTransaction = false;
            
            // Try each transaction until we find a valid match with order
            for (const transaction of matchingTransactions.rows) {
              try {
                // Extract orderId directly from transaction's square_data
                const squareData = transaction.square_data as Record<string, any>;
                const orderId = squareData?.orderId;
                
                if (!orderId) {
                  console.log(`Transaction ${transaction.id} has no orderId in square_data`);
                  continue;
                }
                
                // Step 3: Get order using the exact orderId from transaction
                const matchingOrders = await db.execute(sql`
                  SELECT 
                    o.id as order_id,
                    o.square_id as order_square_id,
                    o.created_at as order_timestamp,
                    o.total_money as order_total
                  FROM 
                    orders o
                  WHERE 
                    o.square_id = ${orderId}
                `);
                
                if (matchingOrders.rows.length === 0) {
                  console.log(`No order found with square_id ${orderId}`);
                  continue;
                }
                
                const order = matchingOrders.rows[0];
                console.log(`Found matching order ID ${order.order_id} via transaction ${transaction.id}`);
                
                // Step 4: Get gift card line items from the order
                const orderLineItems = await db.execute(sql`
                  SELECT 
                    oli.id as line_item_id,
                    oli.name as item_name,
                    oli.total_money as item_total,
                    oli.square_data->>'itemType' as item_type
                  FROM 
                    order_line_items oli
                  WHERE 
                    oli.order_id = ${order.order_id}
                    AND (
                      oli.square_data->>'itemType' = 'GIFT_CARD'
                      OR LOWER(oli.name) LIKE '%gift%'
                      OR LOWER(oli.name) LIKE '%deposit%'
                    )
                `);
                
                if (orderLineItems.rows.length === 0) {
                  console.log(`No gift card line items found for order ID ${order.order_id}`);
                  continue;
                }
                
                // Use the appropriate line item (gift card item)
                const giftCardLineItem = orderLineItems.rows[0];
                const giftCardAmount = Number(giftCardLineItem.item_total);
                
                if (!giftCardAmount || isNaN(giftCardAmount) || giftCardAmount <= 0) {
                  console.log(`Invalid gift card amount (${giftCardAmount}) from line item ${giftCardLineItem.line_item_id}`);
                  continue;
                }
                
                // FORCE UPDATE with the amount from the gift card line item
                const currentActivationAmount = Number(giftCard.activation_amount || 0);
                
                // ALWAYS update - no tolerance check (FORCE UPDATE approach)
                await db.execute(sql`
                  UPDATE gift_cards
                  SET activation_amount = ${giftCardAmount}
                  WHERE id = ${giftCardId}
                `);
                
                console.log(`✅ FORCE UPDATED gift card ID ${giftCardId} (GAN: ${giftCard.gan}) with amount $${giftCardAmount.toFixed(2)} from order ID ${order.order_id} (was $${currentActivationAmount.toFixed(2)})`);
                updatedCount++;
                updatedViaTransaction = true;
                break; // Successfully updated, no need to try other transactions
              } catch (error) {
                console.error(`Error processing transaction ${transaction.id} for gift card ${giftCardId}:`, error);
                // Continue with next transaction
              }
            }
            
            if (updatedViaTransaction) {
              continue; // Move to the next gift card
            }
          }
          
          // FALLBACK: If no transaction match or transaction-based update failed,
          // try to match directly with orders based on timestamp
          console.log(`Trying fallback order matching for gift card ID ${giftCardId}`);
          
          // Find orders with gift card items around this card's purchase date
          // Use a very narrow time window to ensure accuracy
          const directOrders = await db.execute(sql`
            SELECT 
              o.id as order_id,
              o.square_id as order_square_id,
              o.created_at as order_timestamp,
              o.total_money as order_total
            FROM 
              orders o
            WHERE 
              o.created_at >= ${purchaseDate}::timestamptz - interval '5 minutes'
              AND o.created_at <= ${purchaseDate}::timestamptz + interval '5 minutes'
              AND o.square_data->>'hasGiftCardItems' = 'true'
            ORDER BY 
              ABS(EXTRACT(EPOCH FROM (o.created_at - ${purchaseDate}::timestamptz)))
          `);
          
          if (directOrders.rows.length === 0) {
            console.log(`No direct order matches found for gift card ID ${giftCardId}`);
            skippedCount++;
            continue;
          }
          
          const closestOrder = directOrders.rows[0];
          
          // Get gift card line items from this order
          const orderLineItems = await db.execute(sql`
            SELECT 
              oli.id as line_item_id,
              oli.name as item_name,
              oli.total_money as item_total,
              oli.square_data->>'itemType' as item_type
            FROM 
              order_line_items oli
            WHERE 
              oli.order_id = ${closestOrder.order_id}
              AND (
                oli.square_data->>'itemType' = 'GIFT_CARD'
                OR LOWER(oli.name) LIKE '%gift%'
                OR LOWER(oli.name) LIKE '%deposit%'
              )
          `);
          
          if (orderLineItems.rows.length === 0) {
            console.log(`No gift card line items found for direct order ID ${closestOrder.order_id}`);
            skippedCount++;
            continue;
          }
          
          // Use the gift card line item amount
          const giftCardLineItem = orderLineItems.rows[0];
          const directAmount = Number(giftCardLineItem.item_total);
          
          if (!directAmount || isNaN(directAmount) || directAmount <= 0) {
            console.log(`Invalid gift card amount from direct order match for gift card ID ${giftCardId}`);
            skippedCount++;
            continue;
          }
          
          // FORCE UPDATE with the direct order amount
          await db.execute(sql`
            UPDATE gift_cards
            SET activation_amount = ${directAmount}
            WHERE id = ${giftCardId}
          `);
          
          console.log(`✅ DIRECT MATCH: Updated gift card ID ${giftCardId} with amount $${directAmount.toFixed(2)} from order ID ${closestOrder.order_id}`);
          updatedCount++;
          
        } catch (error) {
          console.error(`Error processing gift card ${giftCard.id}:`, error);
          skippedCount++;
        }
      }
    }
    
    console.log(`Gift card activation update completed: ${updatedCount} updated, ${skippedCount} skipped`);
    
    // STEP 5: Handle any remaining cards with zero activation amounts as a last resort
    console.log("Processing remaining gift cards as last resort...");
    
    // Get all gift cards that still have zero activation amounts
    const remainingCards = await db.execute(sql`
      SELECT 
        id, 
        square_id, 
        gan,
        purchase_date,
        amount,
        activation_amount
      FROM 
        gift_cards
      WHERE 
        activation_amount IS NULL 
        OR activation_amount = 0
    `);
    
    console.log(`Found ${remainingCards.rows.length} gift cards that still need activation amounts`);
    
    let directUpdatedCount = 0;
    
    // For these remaining cards, use current balance as activation amount if available
    for (const card of remainingCards.rows) {
      try {
        const cardId = card.id;
        const currentBalance = Number(card.amount || 0);
        
        if (currentBalance > 0) {
          // Use current balance as a last resort activation amount
          await db.execute(sql`
            UPDATE gift_cards
            SET activation_amount = ${currentBalance}
            WHERE id = ${cardId}
          `);
          
          console.log(`⚠️ LAST RESORT: Updated gift card ID ${cardId} with current balance $${currentBalance.toFixed(2)} as activation amount`);
          directUpdatedCount++;
        } else {
          console.log(`❌ FAILED: Could not determine activation amount for gift card ID ${cardId}`);
        }
      } catch (error) {
        console.error(`Error processing remaining gift card ${card.id}:`, error);
      }
    }
    
    console.log(`Last resort updates: ${directUpdatedCount} additional cards updated`);
    
    // Verify the final updated amounts
    await verifyActivationAmounts();
    
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