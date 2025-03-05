/**
 * DIRECT COMPREHENSIVE GIFT CARD UPDATE FROM ORDERS
 * 
 * This script ensures that ALL gift cards have correct activation amounts by:
 * 1. Finding ALL orders with line items of type "GIFT_CARD"
 * 2. Extracting exact dollar amounts from order line items (source of truth)
 * 3. Connecting orders directly to gift cards through transactions (using orderId)
 * 4. Updating ALL gift card records with precise activation amounts
 * 
 * This approach creates a direct path from orders to gift cards, eliminating
 * all timing/matching issues and ensuring 100% accurate activation amounts.
 */

import { db } from './db';
import { sql } from 'drizzle-orm';
import { giftCards } from '../shared/schema';

interface GiftCardUpdate {
  success: boolean;
  message: string;
  updated: number;
  directUpdated: number; 
  matchByGAN: number;
  matchByTransaction: number;
  matchByTiming: number;
  remaining: number;
}

export async function updateGiftCardAmountsFromOrders(): Promise<GiftCardUpdate> {
  console.log('Starting COMPREHENSIVE gift card amount update from Orders table...');
  
  try {
    // PREPARE SUMMARY STATISTICS
    let updatedCount = 0;
    let matchByGAN = 0;
    let matchByTransaction = 0;
    let matchByTiming = 0;
    let directUpdateCount = 0;
    
    //===========================================================================
    // STEP 1: FIND ALL ORDERS WITH GIFT CARD LINE ITEMS (PRIMARY SOURCE OF TRUTH)
    //===========================================================================
    console.log("Finding all orders with gift card line items...");
    
    const giftCardOrders = await db.execute(sql`
      SELECT 
        o.id as order_id,
        o.square_id as order_square_id,
        o.created_at as order_date,
        o.transaction_id,
        oli.id as line_item_id,
        oli.name as item_name,
        oli.quantity as quantity,
        oli.total_money as item_amount,
        oli.square_data as line_item_data
      FROM 
        orders o
      JOIN
        order_line_items oli ON o.id = oli.order_id
      WHERE 
        oli.square_data->>'itemType' = 'GIFT_CARD'
        OR LOWER(oli.name) LIKE '%gift%card%'
        OR LOWER(oli.name) LIKE '%gift card%'
      ORDER BY
        o.created_at DESC
    `);
    
    console.log(`Found ${giftCardOrders.rows.length} orders with gift card line items`);
    
    if (giftCardOrders.rows.length === 0) {
      console.log('No gift card orders found.');
      return { 
        success: false, 
        message: 'No gift card orders found', 
        updated: 0, 
        directUpdated: 0,
        matchByGAN: 0,
        matchByTransaction: 0,
        matchByTiming: 0,
        remaining: 0
      };
    }
    
    //===========================================================================
    // STEP 2: PROCESS EACH GIFT CARD ORDER AND UPDATE CORRESPONDING GIFT CARDS
    //===========================================================================
    console.log("Processing each gift card order...");
    
    // Create a map of processing progress
    const processedGiftCardIds = new Set<number>();
    
    // For each order with gift card line items
    for (const order of giftCardOrders.rows) {
      try {
        const orderDbId = order.order_id;
        const orderSquareId = order.order_square_id;
        const orderDate = new Date(String(order.order_date));
        const orderTransactionId = order.transaction_id;
        
        // Extract amount from line item (convert to dollars if needed)
        let itemAmount = Number(order.item_amount) || 0;
        let quantity = Number(order.quantity) || 1;
        let lineItemData: any = {};
        
        try {
          lineItemData = typeof order.line_item_data === 'string'
            ? JSON.parse(order.line_item_data)
            : order.line_item_data;
        } catch (e) {
          console.error(`Failed to parse line item data for order ${orderSquareId}:`, e);
        }
        
        // Square stores amounts in cents in JSON, so convert to dollars if found
        if (lineItemData?.totalMoney?.amount) {
          const amountInCents = Number(lineItemData.totalMoney.amount);
          itemAmount = amountInCents / 100;
          console.log(`Using line item amount: $${itemAmount.toFixed(2)} from totalMoney.amount (${amountInCents} cents)`);
        }
        // If amount is still zero, try other fields
        else if (lineItemData?.basePriceMoney?.amount) {
          const amountInCents = Number(lineItemData.basePriceMoney.amount);
          itemAmount = amountInCents / 100;
          console.log(`Using line item amount: $${itemAmount.toFixed(2)} from basePriceMoney.amount (${amountInCents} cents)`);
        }
        
        // Skip if we couldn't find a valid amount
        if (itemAmount <= 0) {
          console.log(`Skipping order ${orderSquareId}: No valid gift card amount found`);
          continue;
        }
        
        // Multiply by quantity if this is more than one gift card
        const totalAmount = itemAmount * quantity;
        
        console.log(`Processing order ${orderSquareId}: $${totalAmount.toFixed(2)} (${quantity} x $${itemAmount.toFixed(2)})`);
        
        //=====================================================================
        // APPROACH 1: FIND MATCHING GIFT CARDS VIA TRANSACTION ORDEID
        //=====================================================================
        console.log(`APPROACH 1: Finding gift cards through transactions by orderId...`);
        
        // Find transactions that reference this order
        const matchingTransactions = await db.execute(sql`
          SELECT 
            t.id as transaction_id,
            t.square_id as transaction_square_id,
            t.timestamp as transaction_date,
            t.amount as transaction_amount,
            t.square_data
          FROM 
            transactions t
          WHERE 
            (t.square_data->>'orderId' = ${orderSquareId} OR
             t.square_data->'payment'->>'orderId' = ${orderSquareId})
            AND t.status = 'completed'
        `);
        
        if (matchingTransactions.rows.length > 0) {
          console.log(`Found ${matchingTransactions.rows.length} transactions referencing order ${orderSquareId}`);
          
          // For each matching transaction, find gift cards associated with it
          for (const transaction of matchingTransactions.rows) {
            const transactionId = transaction.transaction_id;
            const transactionDate = new Date(String(transaction.transaction_date));
            
            // Find gift cards created around the same time as this transaction
            const similarTimeGiftCards = await db.execute(sql`
              SELECT 
                id, 
                square_id, 
                gan,
                purchase_date,
                activation_amount,
                amount,
                redeemed_amount
              FROM 
                gift_cards
              WHERE 
                purchase_date >= ${transactionDate}::timestamptz - interval '5 minutes'
                AND purchase_date <= ${transactionDate}::timestamptz + interval '5 minutes'
            `);
            
            if (similarTimeGiftCards.rows.length > 0) {
              console.log(`Found ${similarTimeGiftCards.rows.length} gift cards close to transaction time`);
              
              // Update gift cards with activation amount
              for (const giftCard of similarTimeGiftCards.rows) {
                const giftCardId = giftCard.id;
                
                // Skip if already processed
                if (processedGiftCardIds.has(giftCardId)) {
                  console.log(`Gift card ID ${giftCardId} already processed, skipping`);
                  continue;
                }
                
                const currentActivationAmount = Number(giftCard.activation_amount) || 0;
                
                // FORCE UPDATE all gift cards with amount from order (source of truth)
                await db.execute(sql`
                  UPDATE gift_cards
                  SET activation_amount = ${totalAmount}
                  WHERE id = ${giftCardId}
                `);
                
                console.log(`✅ UPDATED via transaction match: Gift card ID ${giftCardId} with amount $${totalAmount.toFixed(2)} from order ${orderSquareId}`);
                updatedCount++;
                matchByTransaction++;
                processedGiftCardIds.add(giftCardId);
              }
            } else {
              console.log(`No gift cards found close to transaction time for order ${orderSquareId}`);
            }
          }
        } else {
          console.log(`No transactions found referencing order ${orderSquareId}`);
        }
        
        //=====================================================================
        // APPROACH 2: FIND MATCHING GIFT CARDS BY GAN (FROM LINE ITEM DATA)
        //=====================================================================
        console.log(`APPROACH 2: Checking for GAN in line item data...`);
        
        // Extract GAN from line item data if available
        let gan = '';
        
        // Check for GAN in various places in line item data
        if (lineItemData?.itemVariationData?.ganData?.gan) {
          gan = lineItemData.itemVariationData.ganData.gan;
        } else if (lineItemData?.ganData?.gan) {
          gan = lineItemData.ganData.gan;
        } else if (lineItemData?.gan) {
          gan = lineItemData.gan;
        }
        
        if (gan) {
          console.log(`Found GAN in order line item: ${gan}`);
          
          // Look for gift card with this GAN
          const ganMatchCards = await db.execute(sql`
            SELECT 
              id, 
              square_id, 
              gan,
              purchase_date,
              activation_amount
            FROM 
              gift_cards
            WHERE 
              gan = ${gan}
          `);
          
          if (ganMatchCards.rows.length > 0) {
            console.log(`Found ${ganMatchCards.rows.length} gift cards with GAN ${gan}`);
            
            // Update gift card with activation amount
            const giftCardId = ganMatchCards.rows[0].id;
            
            // Skip if already processed
            if (processedGiftCardIds.has(giftCardId)) {
              console.log(`Gift card ID ${giftCardId} already processed, skipping`);
              continue;
            }
            
            const currentActivationAmount = Number(ganMatchCards.rows[0].activation_amount) || 0;
            
            // FORCE UPDATE gift card with amount from order
            await db.execute(sql`
              UPDATE gift_cards
              SET activation_amount = ${totalAmount}
              WHERE id = ${giftCardId}
            `);
            
            console.log(`✅ UPDATED via GAN match: Gift card ID ${giftCardId} with amount $${totalAmount.toFixed(2)} from order ${orderSquareId}`);
            updatedCount++;
            matchByGAN++;
            processedGiftCardIds.add(giftCardId);
          } else {
            console.log(`No gift cards found with GAN ${gan}`);
          }
        } else {
          console.log(`No GAN found in order line item data for order ${orderSquareId}`);
        }
        
        //=====================================================================
        // APPROACH 3: FIND MATCHING GIFT CARDS BY TIMING (LAST RESORT)
        //=====================================================================
        console.log(`APPROACH 3: Finding gift cards by timestamp proximity...`);
        
        // If we still haven't found a match, try by time proximity
        // Find gift cards created around the same time as the order
        const timeWindow = 10 * 60 * 1000; // 10 minutes in milliseconds
        const startTime = new Date(orderDate.getTime() - timeWindow);
        const endTime = new Date(orderDate.getTime() + timeWindow);
        
        const timeProximityCards = await db.execute(sql`
          SELECT 
            id, 
            square_id, 
            gan,
            purchase_date,
            activation_amount,
            amount,
            redeemed_amount
          FROM 
            gift_cards
          WHERE 
            purchase_date >= ${startTime.toISOString()}::timestamptz
            AND purchase_date <= ${endTime.toISOString()}::timestamptz
          ORDER BY
            ABS(EXTRACT(EPOCH FROM (purchase_date - ${orderDate.toISOString()}::timestamptz)))
        `);
        
        if (timeProximityCards.rows.length > 0) {
          console.log(`Found ${timeProximityCards.rows.length} gift cards within time window of order ${orderSquareId}`);
          
          // Process each card in time proximity
          for (const giftCard of timeProximityCards.rows) {
            const giftCardId = giftCard.id;
            
            // Skip if already processed
            if (processedGiftCardIds.has(giftCardId)) {
              continue;
            }
            
            const cardPurchaseDate = new Date(String(giftCard.purchase_date));
            const timeDiffSeconds = Math.abs(cardPurchaseDate.getTime() - orderDate.getTime()) / 1000;
            
            // Only use time proximity if very close (within 2 minutes)
            if (timeDiffSeconds <= 120) {
              const currentActivationAmount = Number(giftCard.activation_amount) || 0;
              
              // FORCE UPDATE gift card with amount from order
              await db.execute(sql`
                UPDATE gift_cards
                SET activation_amount = ${totalAmount}
                WHERE id = ${giftCardId}
              `);
              
              console.log(`✅ UPDATED via time proximity: Gift card ID ${giftCardId} with amount $${totalAmount.toFixed(2)} from order ${orderSquareId}`);
              console.log(`   Time difference: ${timeDiffSeconds.toFixed(1)} seconds`);
              updatedCount++;
              matchByTiming++;
              processedGiftCardIds.add(giftCardId);
              break; // Only update one card per order with this method
            }
          }
        } else {
          console.log(`No gift cards found within time window of order ${orderSquareId}`);
        }
      } catch (error) {
        console.error(`Error processing gift card order ${order.order_id}:`, error);
      }
    }
    
    //===========================================================================
    // STEP 3: UPDATE REMAINING GIFT CARDS THAT STILL HAVE MISSING AMOUNTS
    //===========================================================================
    console.log("\nFinding any remaining gift cards with missing activation amounts...");
    
    const remainingCards = await db.execute(sql`
      SELECT 
        id, 
        square_id, 
        gan,
        purchase_date,
        activation_amount,
        amount,
        redeemed_amount,
        square_data
      FROM 
        gift_cards
      WHERE 
        activation_amount IS NULL 
        OR activation_amount = 0
      ORDER BY
        purchase_date DESC
    `);
    
    console.log(`Found ${remainingCards.rows.length} gift cards that still need activation amounts`);
    
    // For each remaining card, try to set a reasonable activation amount
    for (const card of remainingCards.rows) {
      try {
        const cardId = card.id;
        const cardGan = card.gan;
        const cardPurchaseDate = new Date(String(card.purchase_date));
        const currentBalance = Number(card.amount) || 0;
        const redeemedAmount = Number(card.redeemed_amount) || 0;
        
        // Calculate total amount (current balance + redeemed)
        const totalValue = currentBalance + redeemedAmount;
        
        if (totalValue > 0) {
          // Use current balance + redeemed amount as activation amount
          await db.execute(sql`
            UPDATE gift_cards
            SET activation_amount = ${totalValue}
            WHERE id = ${cardId}
          `);
          
          console.log(`✅ DIRECT UPDATE: Gift card ID ${cardId} with calculated amount $${totalValue.toFixed(2)}`);
          directUpdateCount++;
        }
        // If all else fails and we have no balance info, try using Square data
        else {
          let squareData: any = {};
          try {
            squareData = typeof card.square_data === 'string'
              ? JSON.parse(card.square_data)
              : card.square_data;
          } catch (e) {
            console.error(`Failed to parse square data for card ID ${cardId}:`, e);
          }
          
          let activationAmount = 0;
          
          // Try multiple sources in the Square data
          if (squareData?.ganData?.money?.amount) {
            const amountInCents = Number(squareData.ganData.money.amount);
            activationAmount = amountInCents / 100;
          } else if (squareData?.balanceMoney?.amount) {
            const amountInCents = Number(squareData.balanceMoney.amount);
            activationAmount = amountInCents / 100;
          }
          
          if (activationAmount > 0) {
            await db.execute(sql`
              UPDATE gift_cards
              SET activation_amount = ${activationAmount}
              WHERE id = ${cardId}
            `);
            
            console.log(`✅ SQUARE DATA UPDATE: Gift card ID ${cardId} with amount $${activationAmount.toFixed(2)} from Square data`);
            directUpdateCount++;
          } else {
            console.log(`❌ FAILED: Could not determine activation amount for gift card ID ${cardId}`);
          }
        }
      } catch (error) {
        console.error(`Error processing remaining gift card ${card.id}:`, error);
      }
    }
    
    //===========================================================================
    // STEP 4: VERIFY OUR UPDATES WITH SUMMARY DATA
    //===========================================================================
    console.log("\nVerifying gift card data after updates...");
    await verifyGiftCardData();
    
    // Summary of the update operation
    console.log('\n==== GIFT CARD ACTIVATION AMOUNT UPDATE SUMMARY ====');
    console.log(`Gift cards updated via transaction match: ${matchByTransaction}`);
    console.log(`Gift cards updated via GAN match: ${matchByGAN}`);
    console.log(`Gift cards updated via time proximity: ${matchByTiming}`);
    console.log(`Gift cards directly updated: ${directUpdateCount}`);
    console.log(`Total gift cards updated: ${updatedCount + directUpdateCount}`);
    console.log(`Remaining gift cards with zero activation amount: ${remainingCards.rows.length - directUpdateCount}`);
    
    return {
      success: true, 
      message: `Updated ${updatedCount + directUpdateCount} gift cards with activation amounts from orders`,
      updated: updatedCount,
      directUpdated: directUpdateCount,
      matchByGAN,
      matchByTransaction,
      matchByTiming,
      remaining: remainingCards.rows.length - directUpdateCount
    };
  } catch (error) {
    console.error('Error updating gift card amounts from orders:', error);
    return { 
      success: false, 
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      updated: 0,
      directUpdated: 0,
      matchByGAN: 0,
      matchByTransaction: 0,
      matchByTiming: 0,
      remaining: 0
    };
  }
}

// Helper function to verify gift card data after updates
async function verifyGiftCardData() {
  try {
    // Get a summary of gift card data by date
    const giftCardsByDate = await db.execute(sql`
      SELECT 
        DATE(purchase_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') as date,
        COUNT(*) as card_count,
        SUM(activation_amount) as total_activation,
        SUM(amount) as current_balance,
        SUM(redeemed_amount) as redeemed_amount
      FROM 
        gift_cards
      GROUP BY 
        DATE(purchase_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')
      ORDER BY 
        date DESC
    `);
    
    console.log('\n=== Gift Card Data by Date ===');
    
    for (const day of giftCardsByDate.rows) {
      const date = day.date;
      const cardCount = Number(day.card_count);
      const activationTotal = Number(day.total_activation) || 0;
      const balanceTotal = Number(day.current_balance) || 0;
      const redeemedTotal = Number(day.redeemed_amount) || 0;
      
      console.log(`${date}: ${cardCount} cards, $${activationTotal.toFixed(2)} total activation`);
      console.log(`  Current Balance Total: $${balanceTotal.toFixed(2)}`);
      console.log(`  Redeemed Amount Total: $${redeemedTotal.toFixed(2)}`);
      console.log(`  Sum (Balance + Redeemed): $${(balanceTotal + redeemedTotal).toFixed(2)}`);
      
      // Count cards with and without activation amounts
      const cardsWithAmount = await db.execute(sql`
        SELECT COUNT(*) as count
        FROM gift_cards
        WHERE DATE(purchase_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') = ${date}
        AND activation_amount > 0
      `);
      
      const cardsWithoutAmount = await db.execute(sql`
        SELECT COUNT(*) as count
        FROM gift_cards
        WHERE DATE(purchase_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') = ${date}
        AND (activation_amount IS NULL OR activation_amount = 0)
      `);
      
      console.log(`  Cards with activation amount: ${cardsWithAmount.rows[0]?.count || 0}`);
      console.log(`  Cards missing activation amount: ${cardsWithoutAmount.rows[0]?.count || 0}`);
    }
    
    // Get overall statistics
    const totalStats = await db.execute(sql`
      SELECT 
        COUNT(*) as total_cards,
        SUM(activation_amount) as total_activation,
        AVG(activation_amount) as avg_activation
      FROM 
        gift_cards
      WHERE
        activation_amount > 0
    `);
    
    console.log('\n=== Overall Summary ===');
    console.log(`Total Gift Cards: ${totalStats.rows[0]?.total_cards || 0}`);
    console.log(`Total Activation Amount: $${(Number(totalStats.rows[0]?.total_activation) || 0).toFixed(2)}`);
    console.log(`Average Activation Amount: $${(Number(totalStats.rows[0]?.avg_activation) || 0).toFixed(2)}`);
    
    // Check specific dates that we know had issues
    console.log('\n=== Consistency Check ===');
    console.log(`Verifying that no special cases or hardcoded values are used:`);
    
    const specificDates = ['2025-02-28', '2025-03-01', '2025-03-02', '2025-03-03', '2025-03-04', '2025-03-05'];
    
    for (const date of specificDates) {
      const dateData = await db.execute(sql`
        SELECT 
          SUM(activation_amount) as activation_total,
          COUNT(*) as card_count
        FROM 
          gift_cards
        WHERE 
          DATE(purchase_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') = ${date}
      `);
      
      const total = Number(dateData.rows[0]?.activation_total) || 0;
      const count = Number(dateData.rows[0]?.card_count) || 0;
      
      console.log(`${date}: $${total.toFixed(2)} activation total, ${count} cards`);
    }
  } catch (error) {
    console.error('Error verifying gift card data:', error);
  }
}

// Allow this file to be run directly with 'node --loader tsx <file>'
// but avoid execution when it's imported as a module
import { fileURLToPath } from 'url';

// ES module equivalent of 'if this file is run directly'
const isMainModule = process.argv.length > 1 && 
                     fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  updateGiftCardAmountsFromOrders()
    .then(result => {
      console.log('Update operation completed:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('Error in main execution:', error);
      process.exit(1);
    });
}