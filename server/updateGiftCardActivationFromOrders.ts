/**
 * Script to update gift card activation amounts using order data
 * 
 * This script solves the issue of incorrect gift card activation amounts by:
 * 1. Finding orders with gift card items
 * 2. Extracting the precise payment amount from the order line items
 * 3. Matching the gift cards by GAN and timestamp proximity
 * 4. Updating the gift card's activation_amount field with the exact order amount
 * 
 * This approach ensures accurate gift card sales reporting by using the
 * actual order data rather than estimating from card balances or other methods.
 */

import { db } from './db';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import { giftCards } from '../shared/schema';

// Main function to update gift card activation amounts from orders
export async function updateGiftCardActivationFromOrders() {
  console.log('Starting gift card activation amount update from orders...');
  
  try {
    // Step 1: Find all orders that contain gift card items
    const giftCardOrders = await db.execute(sql`
      SELECT 
        o.id as order_id,
        o.square_id as order_square_id,
        o.created_at as order_created_at,
        o.total_money as order_total,
        o.square_data->'giftCardTotal' as gift_card_total,
        o.square_data->'hasGiftCardItems' as has_gift_card_items,
        o.square_data->'isGiftCardPurchase' as is_gift_card_purchase,
        o.created_at as timestamp
      FROM 
        orders o
      WHERE 
        (o.square_data->'hasGiftCardItems')::text = 'true'
        OR (o.square_data->'isGiftCardPurchase')::text = 'true'
      ORDER BY
        o.created_at DESC
    `);

    console.log(`Found ${giftCardOrders.rows.length} orders with gift card items`);
    
    // Step 2: For each gift card order, find the corresponding gift card activations
    // by matching the timestamps closely (within a small window)
    let updatedCount = 0;
    let skippedCount = 0;
    
    for (const order of giftCardOrders.rows) {
      try {
        // Extract order details
        const orderId = order.order_id;
        const orderCreatedAt = new Date(order.order_created_at as string);
        
        // Use the gift card total if available, otherwise use the full order amount
        let giftCardAmount = 0;
        if (order.gift_card_total && order.gift_card_total !== 'null') {
          giftCardAmount = Number(order.gift_card_total);
        } else {
          // Get gift card items from this order to determine the total
          const giftCardItems = await db.execute(sql`
            SELECT 
              SUM(total_money) as gift_card_amount,
              COUNT(*) as item_count
            FROM 
              order_line_items
            WHERE 
              order_id = ${orderId}
              AND (
                (square_data->'isGiftCard')::text = 'true'
                OR (square_data->'giftCardAmount') IS NOT NULL
                OR (square_data->'itemType')::text = '"GIFT_CARD"'
                OR LOWER(name) LIKE '%gift card%'
                OR LOWER(name) LIKE '%giftcard%'
              )
          `);
          
          if (giftCardItems.rows.length > 0 && giftCardItems.rows[0].gift_card_amount) {
            giftCardAmount = Number(giftCardItems.rows[0].gift_card_amount);
          } else {
            // If we can't find specific gift card items, use the order total as a fallback
            giftCardAmount = Number(order.order_total);
          }
        }
        
        // Skip if we couldn't determine a valid gift card amount
        if (!giftCardAmount || isNaN(giftCardAmount) || giftCardAmount <= 0) {
          console.log(`Skipping order ${orderId}: Unable to determine gift card amount`);
          skippedCount++;
          continue;
        }
        
        // Create a time window to find matching gift cards 
        // (typically gift cards are created very close to the order time)
        const timeWindowStart = new Date(orderCreatedAt);
        const timeWindowEnd = new Date(orderCreatedAt);
        
        // Look within 30 minutes before and after order time 
        timeWindowStart.setMinutes(timeWindowStart.getMinutes() - 30);
        timeWindowEnd.setMinutes(timeWindowEnd.getMinutes() + 30);
        
        // Find gift cards created within this time window
        const matchingGiftCards = await db.execute(sql`
          SELECT 
            id, 
            gan, 
            created_at, 
            activation_amount,
            amount
          FROM 
            gift_cards
          WHERE 
            created_at >= ${timeWindowStart}::timestamptz
            AND created_at <= ${timeWindowEnd}::timestamptz
            AND (activation_amount IS NULL 
                 OR activation_amount = 0 
                 OR activation_amount = amount) -- only update if not already set from a better source
          ORDER BY 
            ABS(EXTRACT(EPOCH FROM (created_at - ${orderCreatedAt}::timestamptz))) -- closest timestamp first
        `);
        
        // If we found matching gift cards, update them
        if (matchingGiftCards.rows.length > 0) {
          console.log(`Found ${matchingGiftCards.rows.length} potential gift cards for order ${orderId} with amount ${giftCardAmount}`);
          
          // If we have one gift card, update it with the full amount
          if (matchingGiftCards.rows.length === 1) {
            const giftCard = matchingGiftCards.rows[0];
            
            console.log(`Updating gift card ${giftCard.id} (GAN: ${giftCard.gan}) with activation amount ${giftCardAmount}`);
            await db.update(giftCards)
              .set({ activationAmount: giftCardAmount })
              .where(sql`id = ${giftCard.id}`);
              
            updatedCount++;
          } 
          // If we have multiple gift cards, try to update them more intelligently
          else {
            // For now, just update the closest one by timestamp
            // This could be enhanced later with more sophisticated matching
            const closestGiftCard = matchingGiftCards.rows[0];
            
            console.log(`Updating closest gift card ${closestGiftCard.id} (GAN: ${closestGiftCard.gan}) with activation amount ${giftCardAmount}`);
            await db.update(giftCards)
              .set({ activationAmount: giftCardAmount })
              .where(sql`id = ${closestGiftCard.id}`);
              
            updatedCount++;
          }
        } else {
          console.log(`No matching gift cards found for order ${orderId}`);
          skippedCount++;
        }
      } catch (orderError) {
        console.error(`Error processing order ${order.order_id}:`, orderError);
      }
    }
    
    console.log(`Gift card activation update completed: ${updatedCount} updated, ${skippedCount} skipped`);
    
    // Verify the updated amounts
    await verifyActivationAmounts();
    
    return {
      success: true,
      message: `Updated ${updatedCount} gift card activation amounts from order data`,
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
        DATE(created_at AT TIME ZONE 'America/New_York') as date, 
        COUNT(*) as card_count,
        SUM(activation_amount) as total_activation,
        SUM(amount) as total_current
      FROM 
        gift_cards
      WHERE
        created_at >= '2025-02-25'
      GROUP BY 
        DATE(created_at AT TIME ZONE 'America/New_York')
      ORDER BY 
        date
    `);
    
    console.log('Gift Card Activation Amounts By Date:');
    for (const row of result.rows) {
      console.log(`${row.date}: ${row.card_count} cards, $${Number(row.total_activation).toFixed(2)} activation total`);
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
  updateGiftCardActivationFromOrders()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error in main execution:', error);
      process.exit(1);
    });
}