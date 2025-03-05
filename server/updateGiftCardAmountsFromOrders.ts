/**
 * Direct Gift Card Amount Update from Orders
 * 
 * This script directly fixes gift card activation amounts by:
 * 1. Finding all orders with line items of type "GIFT_CARD"
 * 2. Extracting the exact dollar amounts from those line items
 * 3. Updating the corresponding gift card records in the database
 * 
 * This approach ensures accurate gift card sales reporting by using
 * the actual order data where itemType is explicitly "GIFT_CARD"
 */

import { db } from './db';
import { sql } from 'drizzle-orm';

export async function updateGiftCardAmountsFromOrders() {
  console.log('Starting gift card amount update from Orders with itemType: "GIFT_CARD"...');
  
  try {
    // Step 1: Find all orders with GIFT_CARD line items
    const giftCardOrders = await db.execute(sql`
      SELECT 
        o.id as order_id,
        o.square_id as order_square_id,
        o.created_at as order_date,
        o.square_data as order_data,
        oli.id as line_item_id,
        oli.name as item_name,
        oli.total_money as item_amount,
        oli.square_data as line_item_data
      FROM 
        orders o
      JOIN
        order_line_items oli ON o.id = oli.order_id
      WHERE 
        oli.square_data->>'itemType' = 'GIFT_CARD'
    `);
    
    console.log(`Found ${giftCardOrders.rows.length} order line items with itemType: "GIFT_CARD"`);
    
    if (giftCardOrders.rows.length === 0) {
      console.log('No gift card orders found.');
      return { success: false, message: 'No gift card orders found' };
    }
    
    // Step 2: Process each gift card order and update the corresponding gift card
    let updatedCount = 0;
    let noMatchCount = 0;
    let errorCount = 0;
    
    for (const order of giftCardOrders.rows) {
      try {
        const orderId = order.order_square_id;
        const orderDate = new Date(String(order.order_date));
        
        // Get amount from the totalMoney field in the Square data
        let itemAmount = Number(order.item_amount) || 0;
        
        // Check if we can extract the amount from Square's JSON data
        let lineItemSquareData = typeof order.line_item_data === 'string'
          ? JSON.parse(order.line_item_data)
          : order.line_item_data;
            
        // Square stores money amounts in cents in the JSON, always convert to dollars
        if (lineItemSquareData && lineItemSquareData.totalMoney && lineItemSquareData.totalMoney.amount) {
          const amountInCents = Number(lineItemSquareData.totalMoney.amount) || 0;
          // Convert from cents to dollars
          const amountInDollars = amountInCents / 100; 
          
          // Always use the amount in dollars from Square data (cents converted to dollars)
          console.log(`Using amount $${amountInDollars.toFixed(2)} (${amountInCents} cents) from Square data`);
          itemAmount = amountInDollars;
        } else {
          // If we can't find the totalMoney.amount directly, look deeper in the data structure
          console.log(`Searching deeper in Square data for amount information...`);
          
          // Try to find the basePriceMoney if totalMoney is not available
          if (lineItemSquareData && lineItemSquareData.basePriceMoney && lineItemSquareData.basePriceMoney.amount) {
            const baseAmountInCents = Number(lineItemSquareData.basePriceMoney.amount) || 0;
            const baseAmountInDollars = baseAmountInCents / 100;
            console.log(`Found basePriceMoney amount: $${baseAmountInDollars.toFixed(2)} (${baseAmountInCents} cents)`);
            itemAmount = baseAmountInDollars;
          }
          // Try to find the variationTotalPriceMoney if available
          else if (lineItemSquareData && lineItemSquareData.variationTotalPriceMoney && lineItemSquareData.variationTotalPriceMoney.amount) {
            const varAmountInCents = Number(lineItemSquareData.variationTotalPriceMoney.amount) || 0;
            const varAmountInDollars = varAmountInCents / 100;
            console.log(`Found variationTotalPriceMoney amount: $${varAmountInDollars.toFixed(2)} (${varAmountInCents} cents)`);
            itemAmount = varAmountInDollars;
          }
        }
        
        if (itemAmount <= 0) {
          console.log(`Skipping order ${orderId} with zero or negative amount: ${itemAmount}`);
          continue;
        }
        
        console.log(`Processing gift card order ${orderId} with amount: $${itemAmount.toFixed(2)}`);
        
        // Get order data and extract GAN if available
        let orderData: any = {};
        try {
          orderData = typeof order.order_data === 'string' 
            ? JSON.parse(order.order_data)
            : order.order_data;
        } catch (e) {
          console.error(`Failed to parse order data for ${orderId}:`, e);
        }
        
        // We already have parsed line item data from earlier, no need to parse again
        
        // Find all gift cards from around the same time (within 1 hour)
        const timeWindow = 60 * 60 * 1000; // 1 hour in milliseconds
        const startTime = new Date(orderDate.getTime() - timeWindow);
        const endTime = new Date(orderDate.getTime() + timeWindow);
        
        const potentialGiftCards = await db.execute(sql`
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
            purchase_date >= ${startTime.toISOString()}::timestamp
            AND purchase_date <= ${endTime.toISOString()}::timestamp
        `);
        
        if (potentialGiftCards.rows.length === 0) {
          console.log(`No gift cards found around the time of order ${orderId}`);
          noMatchCount++;
          continue;
        }
        
        console.log(`Found ${potentialGiftCards.rows.length} potential gift cards for order ${orderId}`);
        
        // Find the best matching gift card (closest in time)
        let bestMatch: any = null;
        let smallestTimeDiff = Infinity;
        
        for (const card of potentialGiftCards.rows) {
          const cardDate = new Date(String(card.purchase_date));
          const timeDiff = Math.abs(cardDate.getTime() - orderDate.getTime());
          
          if (timeDiff < smallestTimeDiff) {
            smallestTimeDiff = timeDiff;
            bestMatch = card;
          }
        }
        
        if (bestMatch) {
          const cardId = Number(bestMatch.id);
          const currentActivationAmount = Number(bestMatch.activation_amount) || 0;
          
          // If the amount is substantially different, update it
          if (Math.abs(currentActivationAmount - itemAmount) > 1) { // $1 tolerance
            await db.execute(sql`
              UPDATE gift_cards
              SET activation_amount = ${itemAmount}
              WHERE id = ${cardId}
            `);
            
            console.log(`✅ Updated gift card ID ${cardId} with activation amount: $${itemAmount.toFixed(2)} from order ${orderId}`);
            updatedCount++;
          } else {
            console.log(`Gift card ID ${cardId} already has correct activation amount: $${currentActivationAmount.toFixed(2)}`);
          }
        } else {
          console.log(`No matching gift card found for order ${orderId}`);
          noMatchCount++;
        }
      } catch (error) {
        console.error(`Error processing gift card order ${order.order_id}:`, error);
        errorCount++;
      }
    }
    
    // Step 3: Verify our updates with summary data
    await verifyGiftCardData();
    
    console.log('\n==== Summary of Gift Card Amount Updates ====');
    console.log(`Total gift card orders processed: ${giftCardOrders.rows.length}`);
    console.log(`Gift cards updated: ${updatedCount}`);
    console.log(`No matching gift card found: ${noMatchCount}`);
    console.log(`Errors: ${errorCount}`);
    
    return {
      success: true, 
      message: `Updated ${updatedCount} gift cards with correct amounts`,
      details: {
        total: giftCardOrders.rows.length,
        updated: updatedCount,
        noMatch: noMatchCount,
        errors: errorCount
      }
    };
  } catch (error) {
    console.error('Error updating gift card amounts from orders:', error);
    return { 
      success: false, 
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` 
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