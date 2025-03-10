/**
 * Enhanced Gift Card Activation Fix Service
 * 
 * This module provides a comprehensive solution for accurately determining
 * gift card activation amounts by linking ALL gift cards to their original orders.
 * 
 * MAIN IMPROVEMENTS:
 * 1. Direct Square API integration for both cards and order data
 * 2. Multi-stage matching strategy with expanded timeframes
 * 3. Permanent linking of gift cards to their activation orders
 * 4. Future-proofing through automatic linking during creation
 */
import pg from 'pg';
const { Pool } = pg;
import { db } from '../db';
import { giftCards } from '../../shared/schema';
import { eq, and, between, sql } from 'drizzle-orm';
import * as squareClient from '../squareClient';

/**
 * Result of a gift card fix operation
 */
interface GiftCardFixResult {
  totalProcessed: number;
  updated: number;
  alreadyCorrect: number;
  withoutActivation: number;
  details: {
    id: number;
    gan: string;
    previousAmount: number;
    newAmount: number;
    source: string;
    orderId?: number;
    orderTimestamp?: Date;
    squareOrderId?: string;
  }[];
}

/**
 * Fix ALL gift card activation amounts using order data and Square API
 * 
 * This function takes a comprehensive approach:
 * 1. Identifies gift cards needing activation amount updates
 * 2. Pulls fresh data from Square API to get the most current information
 * 3. Uses multiple matching strategies in a cascading approach:
 *    a. Square Order ID direct matching when available
 *    b. GAN (gift card number) matching with orders
 *    c. Temporal matching (order within 15 minutes of gift card creation)
 *    d. Line item name + amount matching
 * 4. Links gift cards to their original orders for future reference
 * 
 * @returns Detailed results of the fix operation
 */
export async function fixAllGiftCardActivationAmounts(): Promise<GiftCardFixResult> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    console.log('Starting comprehensive gift card activation amount fix...');
    
    // Get total gift card count for reporting
    const totalCards = await pool.query(`SELECT COUNT(*) FROM gift_cards`);
    const totalCardCount = parseInt(totalCards.rows[0].count || '0');
    
    // Initialize result object
    const result: GiftCardFixResult = {
      totalProcessed: totalCardCount,
      updated: 0,
      alreadyCorrect: 0,
      withoutActivation: 0,
      details: []
    };
    
    // STEP 1: Update all gift cards with direct order ID matches from Square data
    // This targets cards that have an order reference directly in their Square data
    const directOrderMatches = await pool.query(`
      WITH order_matches AS (
        SELECT 
          gc.id AS gift_card_id,
          gc.gan,
          gc.activation_amount AS current_amount,
          o.id AS order_id,
          o.square_id AS square_order_id,
          o.created_at AS order_timestamp,
          -- Use base_price_money (original price) instead of total_money (which might be 0 due to discounts)
          COALESCE(oli.base_price_money, oli.total_money, 0) AS order_amount
        FROM gift_cards gc
        -- Find orders where the square_id is referenced in the gift card's square_data
        JOIN orders o ON 
          gc.square_data::text LIKE '%' || o.square_id || '%' OR
          (gc.square_data->>'order_id' = o.square_id) OR
          (gc.square_data->>'orderId' = o.square_id)
        -- Find order line items that could be gift cards
        JOIN order_line_items oli ON 
          oli.order_id = o.id AND 
          (oli.is_gift_card = TRUE OR 
           LOWER(oli.name) LIKE '%gift card%' OR 
           LOWER(oli.name) LIKE '%giftcard%')
        WHERE 
          -- Target gift cards that need fixing (either incorrect value or missing link)
          (gc.activation_payment_id IS NULL OR 
           gc.activation_amount = 50 OR 
           gc.activation_amount = 0)
      )
      UPDATE gift_cards gc
      SET 
        activation_amount = om.order_amount,
        activation_payment_id = om.order_id,
        square_data = jsonb_set(
          COALESCE(gc.square_data::jsonb, '{}'::jsonb),
          '{linked_order_id}',
          to_jsonb(om.square_order_id::text)
        )
      FROM order_matches om
      WHERE gc.id = om.gift_card_id
      RETURNING 
        gc.id,
        gc.gan,
        om.current_amount AS previous_amount,
        gc.activation_amount AS new_amount,
        'direct_order_reference' AS source,
        om.order_id,
        om.order_timestamp,
        om.square_order_id
    `);
    
    console.log(`Fixed ${directOrderMatches.rowCount || 0} gift cards using direct order references`);
    
    // Add details to the result
    if (directOrderMatches.rows && directOrderMatches.rows.length > 0) {
      result.updated += directOrderMatches.rowCount || 0;
      result.details.push(...directOrderMatches.rows.map(row => ({
        id: row.id,
        gan: row.gan,
        previousAmount: parseFloat(row.previous_amount || '0'),
        newAmount: parseFloat(row.new_amount),
        source: row.source,
        orderId: row.order_id,
        orderTimestamp: row.order_timestamp ? new Date(row.order_timestamp) : undefined,
        squareOrderId: row.square_order_id
      })));
    }
    
    // STEP 2: Update gift cards using GAN matching with order line items
    // This targets cards where the gift card number (GAN) is referenced in the order data
    const ganMatches = await pool.query(`
      WITH gan_matches AS (
        SELECT 
          gc.id AS gift_card_id,
          gc.gan,
          gc.activation_amount AS current_amount,
          o.id AS order_id,
          o.square_id AS square_order_id,
          o.created_at AS order_timestamp,
          -- Use base_price_money for accurate pricing (total_money might be 0 due to discounts)
          COALESCE(oli.base_price_money, oli.total_money, 0) AS order_amount
        FROM gift_cards gc
        -- Only include gift cards with a valid GAN and that still need fixing
        WHERE 
          gc.gan IS NOT NULL AND 
          gc.gan != '' AND
          gc.activation_payment_id IS NULL AND
          (gc.activation_amount = 50 OR 
           gc.activation_amount = 0 OR 
           gc.activation_amount IS NULL)
        -- Find orders where the GAN is referenced
        JOIN orders o ON 
          o.square_data::text LIKE '%' || gc.gan || '%' OR
          o.square_id::text LIKE '%' || gc.gan || '%'
        -- Find order line items that could be gift cards
        JOIN order_line_items oli ON 
          oli.order_id = o.id AND 
          (oli.is_gift_card = TRUE OR 
           LOWER(oli.name) LIKE '%gift card%' OR 
           LOWER(oli.name) LIKE '%giftcard%')
        -- Order by timestamp proximity to get best match
        ORDER BY ABS(EXTRACT(EPOCH FROM (gc.purchase_date - o.created_at)))
      )
      UPDATE gift_cards gc
      SET 
        activation_amount = gm.order_amount,
        activation_payment_id = gm.order_id,
        square_data = jsonb_set(
          COALESCE(gc.square_data::jsonb, '{}'::jsonb),
          '{linked_order_id}',
          to_jsonb(gm.square_order_id::text)
        )
      FROM gan_matches gm
      WHERE gc.id = gm.gift_card_id
      -- For each gift card, only take the closest match by time
      AND gm.gift_card_id IN (
        SELECT DISTINCT ON (gift_card_id) gift_card_id
        FROM gan_matches
        ORDER BY gift_card_id, ABS(EXTRACT(EPOCH FROM (gc.purchase_date - gm.order_timestamp))) ASC
      )
      RETURNING 
        gc.id,
        gc.gan,
        gm.current_amount AS previous_amount,
        gc.activation_amount AS new_amount,
        'gan_match' AS source,
        gm.order_id,
        gm.order_timestamp,
        gm.square_order_id
    `);
    
    console.log(`Fixed ${ganMatches.rowCount || 0} gift cards using GAN matching`);
    
    // Add details to the result
    if (ganMatches.rows && ganMatches.rows.length > 0) {
      result.updated += ganMatches.rowCount || 0;
      result.details.push(...ganMatches.rows.map(row => ({
        id: row.id,
        gan: row.gan,
        previousAmount: parseFloat(row.previous_amount || '0'),
        newAmount: parseFloat(row.new_amount),
        source: row.source,
        orderId: row.order_id,
        orderTimestamp: row.order_timestamp ? new Date(row.order_timestamp) : undefined,
        squareOrderId: row.square_order_id
      })));
    }
    
    // STEP 3: Use temporal + line item matching with expanded time window
    // This targets cards where we can find orders with gift card line items created near the gift card creation time
    const temporalMatches = await pool.query(`
      WITH temporal_matches AS (
        SELECT 
          gc.id AS gift_card_id,
          gc.gan,
          gc.activation_amount AS current_amount,
          o.id AS order_id,
          o.square_id AS square_order_id,
          o.created_at AS order_timestamp,
          -- Use base_price_money for accurate pricing (total_money might be 0 due to discounts)
          COALESCE(oli.base_price_money, oli.total_money, 0) AS order_amount,
          -- Calculate time difference in seconds
          ABS(EXTRACT(EPOCH FROM (gc.purchase_date - o.created_at))) AS time_diff_seconds
        FROM gift_cards gc
        -- Find orders created within extended window (30 minutes) of gift card creation
        -- This catches more legitimate matches while still being reasonable
        JOIN orders o ON 
          ABS(EXTRACT(EPOCH FROM (gc.purchase_date - o.created_at))) < 1800
        -- Find order line items that could be gift cards
        JOIN order_line_items oli ON 
          oli.order_id = o.id AND 
          (oli.is_gift_card = TRUE OR 
           LOWER(oli.name) LIKE '%gift card%' OR 
           LOWER(oli.name) LIKE '%giftcard%')
        WHERE 
          -- Only target gift cards that still need fixing after previous steps
          gc.activation_payment_id IS NULL AND
          (gc.activation_amount = 50 OR 
           gc.activation_amount = 0 OR 
           gc.activation_amount IS NULL)
        -- Get the closest match by time
        ORDER BY time_diff_seconds ASC
      )
      UPDATE gift_cards gc
      SET 
        activation_amount = tm.order_amount,
        activation_payment_id = tm.order_id,
        square_data = jsonb_set(
          COALESCE(gc.square_data::jsonb, '{}'::jsonb),
          '{linked_order_id}',
          to_jsonb(tm.square_order_id::text)
        )
      FROM temporal_matches tm
      WHERE gc.id = tm.gift_card_id
      -- For each gift card, only take the best match (closest in time)
      AND tm.time_diff_seconds = (
        SELECT MIN(time_diff_seconds) 
        FROM temporal_matches 
        WHERE gift_card_id = tm.gift_card_id
      )
      RETURNING 
        gc.id,
        gc.gan,
        tm.current_amount AS previous_amount,
        gc.activation_amount AS new_amount,
        'temporal_match' AS source,
        tm.order_id,
        tm.order_timestamp,
        tm.square_order_id
    `);
    
    console.log(`Fixed ${temporalMatches.rowCount || 0} gift cards using temporal + line item matching`);
    
    // Add details to the result
    if (temporalMatches.rows && temporalMatches.rows.length > 0) {
      result.updated += temporalMatches.rowCount || 0;
      result.details.push(...temporalMatches.rows.map(row => ({
        id: row.id,
        gan: row.gan,
        previousAmount: parseFloat(row.previous_amount || '0'),
        newAmount: parseFloat(row.new_amount),
        source: row.source,
        orderId: row.order_id,
        orderTimestamp: row.order_timestamp ? new Date(row.order_timestamp) : undefined,
        squareOrderId: row.square_order_id
      })));
    }
    
    // STEP 4: For remaining cards, pull fresh data from Square API
    // This ensures we have the most current data for any cards still not matched
    const unlinkedCardsQuery = await pool.query(`
      SELECT id, gan, square_id, activation_amount
      FROM gift_cards
      WHERE activation_payment_id IS NULL
        AND (activation_amount = 50 OR activation_amount = 0 OR activation_amount IS NULL)
      LIMIT 50 -- Process in reasonable batches
    `);
    
    const unlinkedCards = unlinkedCardsQuery.rows;
    console.log(`Found ${unlinkedCards.length} gift cards still needing activation amount fixes`);
    
    if (unlinkedCards.length > 0) {
      // Fetch additional data directly from Square for enhanced matching
      try {
        const squareOrders = await squareClient.fetchOrders();
        console.log(`Fetched ${squareOrders.length} orders from Square API for enhanced matching`);
        
        // Temporary store orders in the database for reference if they don't exist
        let importedOrderCount = 0;
        for (const order of squareOrders) {
          try {
            // Check if this order already exists in our database
            const existingOrder = await pool.query(`
              SELECT id FROM orders WHERE square_id = $1
            `, [order.id]);
            
            if (existingOrder.rows.length === 0) {
              // Convert Square order to our schema format
              const orderData = squareClient.convertSquareOrderToOrder(order);
              
              // Insert into orders table
              const newOrder = await pool.query(`
                INSERT INTO orders (
                  square_id, created_at, closed_at, status, total_money, 
                  total_tax, total_discount, source, square_data
                ) VALUES (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9
                ) RETURNING id
              `, [
                orderData.squareId,
                orderData.createdAt,
                orderData.closedAt || null,
                orderData.status,
                orderData.totalMoney || 0,
                orderData.totalTax || 0,
                orderData.totalDiscount || 0,
                orderData.source || 'square',
                orderData.squareData
              ]);
              
              const orderId = newOrder.rows[0].id;
              importedOrderCount++;
              
              // Process line items for gift card detection
              if (order.lineItems) {
                for (const lineItem of order.lineItems) {
                  const lineItemData = squareClient.convertSquareLineItemToOrderLineItem(lineItem, orderId);
                  
                  // Mark if this is a gift card item
                  const isGiftCard = lineItem.name?.toLowerCase().includes('gift card') || 
                                     lineItem.catalogObjectId?.includes('GIFT_CARD');
                  
                  // Extract additional data for line items that might not be in our schema
                  const squareLineItemId = lineItem.uid || lineItem.id || '';
                  const itemName = lineItem.name || 'Unknown Item';
                  const itemQuantity = lineItem.quantity ? parseInt(lineItem.quantity) : 1;
                  const itemTotalMoney = lineItemData.totalMoney || 0;
                  const itemBasePriceMoney = lineItemData.basePriceMoney || itemTotalMoney || 0;
                  const itemVariationName = lineItem.variationName || '';
                  const itemNote = lineItem.note || '';
                  
                  // Insert line item
                  await pool.query(`
                    INSERT INTO order_line_items (
                      order_id, square_id, name, quantity, total_money, 
                      base_price_money, variation_name, note, is_gift_card
                    ) VALUES (
                      $1, $2, $3, $4, $5, $6, $7, $8, $9
                    )
                  `, [
                    orderId,
                    squareLineItemId,
                    itemName,
                    itemQuantity,
                    itemTotalMoney,
                    itemBasePriceMoney,
                    itemVariationName,
                    itemNote,
                    isGiftCard
                  ]);
                }
              }
            }
          } catch (error) {
            console.error(`Error importing order ${order.id}:`, error);
            // Continue with next order
          }
        }
        
        console.log(`Imported ${importedOrderCount} new orders for gift card matching`);
        
        // Now try to match gift cards with the newly imported orders
        const enhancedMatches = await pool.query(`
          WITH enhanced_matches AS (
            SELECT 
              gc.id AS gift_card_id,
              gc.gan,
              gc.activation_amount AS current_amount,
              o.id AS order_id,
              o.square_id AS square_order_id,
              o.created_at AS order_timestamp,
              -- Use base_price_money for accurate pricing
              COALESCE(oli.base_price_money, oli.total_money, 0) AS order_amount,
              ABS(EXTRACT(EPOCH FROM (gc.purchase_date - o.created_at))) AS time_diff_seconds
            FROM gift_cards gc
            -- Only include cards that still need fixing
            WHERE 
              gc.activation_payment_id IS NULL AND
              (gc.activation_amount = 50 OR gc.activation_amount = 0 OR gc.activation_amount IS NULL)
              AND gc.id IN (${unlinkedCards.map(c => c.id).join(',')})
            -- Find orders with gift card items within a reasonable time window (3 hours)
            JOIN orders o ON 
              ABS(EXTRACT(EPOCH FROM (gc.purchase_date - o.created_at))) < 10800
            -- Find order line items that are gift cards
            JOIN order_line_items oli ON 
              oli.order_id = o.id AND 
              (oli.is_gift_card = TRUE OR 
              LOWER(oli.name) LIKE '%gift card%' OR 
              LOWER(oli.name) LIKE '%giftcard%')
            -- Order by time proximity for best match
            ORDER BY time_diff_seconds ASC
          )
          UPDATE gift_cards gc
          SET 
            activation_amount = em.order_amount,
            activation_payment_id = em.order_id,
            square_data = jsonb_set(
              COALESCE(gc.square_data::jsonb, '{}'::jsonb),
              '{linked_order_id}',
              to_jsonb(em.square_order_id::text)
            )
          FROM enhanced_matches em
          WHERE gc.id = em.gift_card_id
          -- For each gift card, only take the best match (closest in time)
          AND em.time_diff_seconds = (
            SELECT MIN(time_diff_seconds) 
            FROM enhanced_matches 
            WHERE gift_card_id = em.gift_card_id
          )
          RETURNING 
            gc.id,
            gc.gan,
            em.current_amount AS previous_amount,
            gc.activation_amount AS new_amount,
            'square_api_enhanced_match' AS source,
            em.order_id,
            em.order_timestamp,
            em.square_order_id
        `);
        
        console.log(`Fixed ${enhancedMatches.rowCount || 0} gift cards using enhanced Square API matching`);
        
        // Add details to the result
        if (enhancedMatches.rows && enhancedMatches.rows.length > 0) {
          result.updated += enhancedMatches.rowCount || 0;
          result.details.push(...enhancedMatches.rows.map(row => ({
            id: row.id,
            gan: row.gan,
            previousAmount: parseFloat(row.previous_amount || '0'),
            newAmount: parseFloat(row.new_amount),
            source: row.source,
            orderId: row.order_id,
            orderTimestamp: row.order_timestamp ? new Date(row.order_timestamp) : undefined,
            squareOrderId: row.square_order_id
          })));
        }
      } catch (error) {
        console.error('Error fetching additional data from Square API:', error);
        // Continue with the remaining fixes
      }
    }
    
    // STEP 5: Final fallback - use Square balance data for remaining cards
    // This ensures all cards have a reasonable value based on their current Square data
    const squareBalanceFixes = await pool.query(`
      WITH balance_fixes AS (
        SELECT 
          gc.id AS gift_card_id,
          gc.gan,
          gc.activation_amount AS current_amount,
          CAST((((gc.square_data->>'balanceMoney')::json->>'amount')::numeric / 100) AS NUMERIC(10,2)) AS square_balance
        FROM gift_cards gc
        WHERE 
          -- Only target gift cards still needing fixes after all previous steps
          gc.activation_payment_id IS NULL AND
          (gc.activation_amount = 50 OR gc.activation_amount = 0 OR gc.activation_amount IS NULL) AND
          gc.square_data->>'balanceMoney' IS NOT NULL AND
          (((gc.square_data->>'balanceMoney')::json->>'amount')::numeric / 100) > 0
      )
      UPDATE gift_cards gc
      SET 
        activation_amount = bf.square_balance,
        square_data = jsonb_set(
          COALESCE(gc.square_data::jsonb, '{}'::jsonb),
          '{activation_source}',
          '"square_balance"'::jsonb
        )
      FROM balance_fixes bf
      WHERE gc.id = bf.gift_card_id
      RETURNING 
        gc.id,
        gc.gan,
        bf.current_amount AS previous_amount,
        gc.activation_amount AS new_amount,
        'square_balance' AS source
    `);
    
    console.log(`Fixed ${squareBalanceFixes.rowCount || 0} gift cards using Square balance data`);
    
    // Add details to the result
    if (squareBalanceFixes.rows && squareBalanceFixes.rows.length > 0) {
      result.updated += squareBalanceFixes.rowCount || 0;
      result.details.push(...squareBalanceFixes.rows.map(row => ({
        id: row.id,
        gan: row.gan,
        previousAmount: parseFloat(row.previous_amount || '0'),
        newAmount: parseFloat(row.new_amount),
        source: row.source
      })));
    }
    
    // Get final stats to complete the result
    const finalStats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN activation_amount > 0 THEN 1 END) as with_amount,
        COUNT(CASE WHEN activation_payment_id IS NOT NULL THEN 1 END) as with_payment_id,
        COUNT(CASE WHEN activation_amount IS NULL OR activation_amount = 0 THEN 1 END) as without_amount
      FROM gift_cards
    `);
    
    if (finalStats.rows && finalStats.rows.length > 0) {
      result.alreadyCorrect = parseInt(finalStats.rows[0].with_amount) - result.updated;
      result.withoutActivation = parseInt(finalStats.rows[0].without_amount || '0');
    }
    
    console.log(`
      Gift card activation fix complete:
      - Total gift cards: ${result.totalProcessed}
      - Updated: ${result.updated}
      - Already correct: ${result.alreadyCorrect}
      - Still without activation amount: ${result.withoutActivation}
      - Cards linked to payments: ${finalStats.rows[0].with_payment_id || 0}
    `);
    
    return result;
    
  } catch (error) {
    console.error('Error fixing gift card activation amounts:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

/**
 * Fix gift card activation amounts when a new gift card is created
 * 
 * This function is designed to be called when a new gift card is created
 * to immediately link it to the correct order and set the proper activation amount.
 * This ensures all future gift cards have accurate data from the start.
 * 
 * @param giftCardId The ID of the newly created gift card
 * @returns The updated gift card with accurate activation amount
 */
export async function fixNewGiftCardActivationAmount(giftCardId: number): Promise<any> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    console.log(`Fixing activation amount for new gift card ${giftCardId}...`);
    
    // Get the gift card data
    const giftCardResult = await pool.query(`
      SELECT * FROM gift_cards WHERE id = $1
    `, [giftCardId]);
    
    if (giftCardResult.rows.length === 0) {
      throw new Error(`Gift card with ID ${giftCardId} not found`);
    }
    
    const giftCard = giftCardResult.rows[0];
    
    // If the gift card already has a proper activation amount and payment ID, nothing to do
    if (giftCard.activation_payment_id && giftCard.activation_amount > 0 && giftCard.activation_amount !== 50) {
      console.log(`Gift card ${giftCardId} already has activation data: $${giftCard.activation_amount} from payment ${giftCard.activation_payment_id}`);
      return giftCard;
    }
    
    // Try to find a matching order created within 15 minutes of the gift card
    const orderMatches = await pool.query(`
      SELECT 
        o.id AS order_id,
        o.square_id,
        o.created_at,
        COALESCE(oli.base_price_money, oli.total_money, 0) AS amount,
        ABS(EXTRACT(EPOCH FROM (o.created_at - $1))) AS time_diff_seconds
      FROM orders o
      JOIN order_line_items oli ON 
        oli.order_id = o.id AND 
        (oli.is_gift_card = TRUE OR 
         LOWER(oli.name) LIKE '%gift card%' OR 
         LOWER(oli.name) LIKE '%giftcard%')
      WHERE 
        ABS(EXTRACT(EPOCH FROM (o.created_at - $1))) < 900
      ORDER BY time_diff_seconds ASC
      LIMIT 1
    `, [giftCard.purchase_date]);
    
    if (orderMatches.rows.length > 0) {
      const orderMatch = orderMatches.rows[0];
      
      // Update the gift card with the matching order data
      await pool.query(`
        UPDATE gift_cards
        SET 
          activation_amount = $1,
          activation_payment_id = $2,
          square_data = jsonb_set(
            COALESCE(square_data::jsonb, '{}'::jsonb),
            '{linked_order_id}',
            $3::jsonb
          )
        WHERE id = $4
      `, [
        orderMatch.amount,
        orderMatch.order_id,
        JSON.stringify(orderMatch.square_id),
        giftCardId
      ]);
      
      console.log(`Updated gift card ${giftCardId} with activation amount $${orderMatch.amount} from order ${orderMatch.order_id}`);
      
      // Get the updated gift card
      const updatedGiftCard = await pool.query(`
        SELECT * FROM gift_cards WHERE id = $1
      `, [giftCardId]);
      
      return updatedGiftCard.rows[0];
    } else {
      console.log(`No matching order found for gift card ${giftCardId}`);
      
      // If no match found, fall back to using balance data if available
      if (giftCard.square_data?.balanceMoney?.amount) {
        const balanceAmount = Number(giftCard.square_data.balanceMoney.amount) / 100;
        
        if (balanceAmount > 0) {
          await pool.query(`
            UPDATE gift_cards
            SET 
              activation_amount = $1,
              square_data = jsonb_set(
                COALESCE(square_data::jsonb, '{}'::jsonb),
                '{activation_source}',
                '"square_balance"'::jsonb
              )
            WHERE id = $2
          `, [balanceAmount, giftCardId]);
          
          console.log(`Updated gift card ${giftCardId} with activation amount $${balanceAmount} from balance data`);
          
          // Get the updated gift card
          const updatedGiftCard = await pool.query(`
            SELECT * FROM gift_cards WHERE id = $1
          `, [giftCardId]);
          
          return updatedGiftCard.rows[0];
        }
      }
      
      // If still no match, return the original gift card
      return giftCard;
    }
  } catch (error) {
    console.error(`Error fixing new gift card ${giftCardId}:`, error);
    throw error;
  } finally {
    await pool.end();
  }
}

/**
 * Analyze and report on gift card activation amounts and linking status
 * 
 * This function provides a comprehensive overview of the current state of
 * gift card activation amounts and linking to orders.
 * 
 * @returns Detailed analysis report
 */
export async function analyzeGiftCardLinkingStatus(): Promise<{
  totalGiftCards: number;
  withActivationAmount: number;
  withoutActivationAmount: number;
  withOrderLink: number;
  withoutOrderLink: number;
  avgActivationAmount: number;
  amountDistribution: Record<string, number>;
  ordersWithGiftCards: number;
  recentFixedCards: any[];
}> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // Query for basic statistics
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_cards,
        COUNT(CASE WHEN activation_amount > 0 THEN 1 END) as with_amount,
        COUNT(CASE WHEN activation_amount IS NULL OR activation_amount = 0 THEN 1 END) as without_amount,
        COUNT(CASE WHEN activation_payment_id IS NOT NULL THEN 1 END) as with_order_link,
        COUNT(CASE WHEN activation_payment_id IS NULL THEN 1 END) as without_order_link,
        CAST(AVG(CASE WHEN activation_amount > 0 THEN activation_amount ELSE NULL END) AS DECIMAL(10,2)) as avg_amount
      FROM gift_cards
    `);
    
    // Query for amount distribution
    const distributionResult = await pool.query(`
      SELECT 
        CASE 
          WHEN activation_amount < 1 THEN '0'
          WHEN activation_amount BETWEEN 1 AND 25 THEN '1-25'
          WHEN activation_amount BETWEEN 26 AND 50 THEN '26-50'
          WHEN activation_amount BETWEEN 51 AND 100 THEN '51-100'
          WHEN activation_amount BETWEEN 101 AND 200 THEN '101-200'
          ELSE 'Over 200'
        END as range_name,
        COUNT(*) as count
      FROM gift_cards
      GROUP BY 1
      ORDER BY 
        CASE 
          WHEN range_name = '0' THEN 0
          WHEN range_name = '1-25' THEN 1
          WHEN range_name = '26-50' THEN 2
          WHEN range_name = '51-100' THEN 3
          WHEN range_name = '101-200' THEN 4
          WHEN range_name = 'Over 200' THEN 5
          ELSE 6
        END
    `);
    
    // Count orders with gift card line items
    const orderResult = await pool.query(`
      SELECT COUNT(DISTINCT o.id) as count
      FROM orders o
      JOIN order_line_items oli ON oli.order_id = o.id
      WHERE 
        oli.is_gift_card = TRUE OR
        LOWER(oli.name) LIKE '%gift card%' OR
        LOWER(oli.name) LIKE '%giftcard%'
    `);
    
    // Get 10 recently fixed gift cards for example
    const recentFixedResult = await pool.query(`
      SELECT 
        gc.id,
        gc.gan,
        gc.activation_amount,
        gc.activation_payment_id,
        gc.purchase_date,
        o.created_at as order_created_at,
        o.square_id as order_square_id,
        oli.name as item_name,
        oli.base_price_money as item_price
      FROM gift_cards gc
      JOIN orders o ON gc.activation_payment_id = o.id
      JOIN order_line_items oli ON 
        oli.order_id = o.id AND 
        (oli.is_gift_card = TRUE OR 
         LOWER(oli.name) LIKE '%gift card%' OR 
         LOWER(oli.name) LIKE '%giftcard%')
      ORDER BY gc.purchase_date DESC
      LIMIT 10
    `);
    
    // Build the distribution map
    const amountDistribution: Record<string, number> = {};
    distributionResult.rows.forEach(row => {
      amountDistribution[row.range_name] = parseInt(row.count);
    });
    
    return {
      totalGiftCards: parseInt(statsResult.rows[0].total_cards || '0'),
      withActivationAmount: parseInt(statsResult.rows[0].with_amount || '0'),
      withoutActivationAmount: parseInt(statsResult.rows[0].without_amount || '0'),
      withOrderLink: parseInt(statsResult.rows[0].with_order_link || '0'),
      withoutOrderLink: parseInt(statsResult.rows[0].without_order_link || '0'),
      avgActivationAmount: parseFloat(statsResult.rows[0].avg_amount || '0'),
      amountDistribution,
      ordersWithGiftCards: parseInt(orderResult.rows[0].count || '0'),
      recentFixedCards: recentFixedResult.rows
    };
  } catch (error) {
    console.error('Error analyzing gift card linking status:', error);
    throw error;
  } finally {
    await pool.end();
  }
}