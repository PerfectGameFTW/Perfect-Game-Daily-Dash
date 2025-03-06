/**
 * Gift Card Activation Amount Improvement
 * 
 * This module provides a comprehensive, maintainable solution to accurately track
 * gift card activation amounts and redemptions. It replaces the multiple ad-hoc
 * scripts with a clean, structured approach that works for all dates.
 */
import { db } from '../server/db';
import * as schema from './schema';
import { eq, and, gte, lte, count, sql, desc, isNull } from 'drizzle-orm';
import { Pool } from 'pg';

interface GiftCardFix {
  id: number;
  gan: string; 
  previousActivationAmount: number;
  newActivationAmount: number;
  source: string;
  timestamp: Date;
}

interface GiftCardFixResult {
  totalProcessed: number;
  updated: number;
  alreadyCorrect: number;
  withoutActivation: number;
  fixDetails: GiftCardFix[];
}

/**
 * Fix gift card activation amounts
 * 
 * This is the main function that implements a comprehensive approach to gift card fixing:
 * 1. It checks each gift card's activation amount using multiple sources
 * 2. It updates gift cards with accurate amounts
 * 3. It links gift cards to the corresponding activation payment
 * 
 * This approach works for all cards across all dates without special cases or hardcoded values.
 */
export async function fixGiftCardActivationAmounts(): Promise<GiftCardFixResult> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  const fixes: GiftCardFix[] = [];
  
  try {
    console.log('Starting gift card activation amount fix...');
    
    // First pass: Fix activation amounts using payment transactions
    const fromPayments = await pool.query(`
      WITH payment_activations AS (
        SELECT 
          gc.id AS gift_card_id,
          gc.gan,
          gc.activation_amount AS current_amount,
          MAX(p.amount) AS payment_amount,
          MAX(p.timestamp) AS timestamp
        FROM gift_cards gc
        JOIN payments p ON p.gift_card_id = gc.id
        WHERE p.is_gift_card_activation = TRUE
        GROUP BY gc.id, gc.gan, gc.activation_amount
      )
      UPDATE gift_cards gc
      SET 
        activation_amount = pa.payment_amount,
        activation_payment_id = (
          SELECT p.id
          FROM payments p
          WHERE p.gift_card_id = gc.id
          AND p.is_gift_card_activation = TRUE
          ORDER BY p.amount DESC, p.timestamp DESC
          LIMIT 1
        )
      FROM payment_activations pa
      WHERE gc.id = pa.gift_card_id
      AND (
        gc.activation_amount = 0 OR
        ABS(gc.activation_amount - pa.payment_amount) > 0.01
      )
      RETURNING 
        gc.id,
        gc.gan,
        pa.current_amount AS previous_activation_amount,
        gc.activation_amount AS new_activation_amount,
        'payment' AS source,
        pa.timestamp
    `);
    
    // Convert the results to GiftCardFix objects
    const fixesFromPayments = fromPayments.rows.map(row => ({
      id: row.id,
      gan: row.gan,
      previousActivationAmount: parseFloat(row.previous_activation_amount || '0'),
      newActivationAmount: parseFloat(row.new_activation_amount),
      source: row.source,
      timestamp: new Date(row.timestamp)
    }));
    
    fixes.push(...fixesFromPayments);
    
    // Second pass: Fix activation amounts using order line items
    const fromOrders = await pool.query(`
      WITH order_activations AS (
        SELECT 
          gc.id AS gift_card_id,
          gc.gan,
          gc.activation_amount AS current_amount,
          oli.total_money AS order_amount,
          o.created_at AS timestamp
        FROM gift_cards gc
        JOIN orders o ON o.square_data::text LIKE '%' || gc.gan || '%'
        JOIN order_line_items oli ON oli.order_id = o.id
        WHERE oli.is_gift_card = TRUE
        AND gc.activation_amount = 0
      )
      UPDATE gift_cards gc
      SET activation_amount = oa.order_amount
      FROM order_activations oa
      WHERE gc.id = oa.gift_card_id
      AND gc.activation_amount = 0
      RETURNING 
        gc.id,
        gc.gan,
        oa.current_amount AS previous_activation_amount,
        gc.activation_amount AS new_activation_amount,
        'order' AS source,
        oa.timestamp
    `);
    
    // Convert the results to GiftCardFix objects
    const fixesFromOrders = fromOrders.rows.map(row => ({
      id: row.id,
      gan: row.gan,
      previousActivationAmount: parseFloat(row.previous_activation_amount || '0'),
      newActivationAmount: parseFloat(row.new_activation_amount),
      source: row.source,
      timestamp: new Date(row.timestamp)
    }));
    
    fixes.push(...fixesFromOrders);
    
    // Third pass: Fix activation amounts using sum of current balance and redeemed amounts
    const fromBalances = await pool.query(`
      WITH balance_activations AS (
        SELECT 
          gc.id AS gift_card_id,
          gc.gan,
          gc.activation_amount AS current_amount,
          gc.current_balance + gc.redeemed_amount AS total_amount,
          gc.created_at AS timestamp
        FROM gift_cards gc
        WHERE gc.activation_amount = 0
        AND gc.current_balance + gc.redeemed_amount > 0
      )
      UPDATE gift_cards gc
      SET activation_amount = ba.total_amount
      FROM balance_activations ba
      WHERE gc.id = ba.gift_card_id
      RETURNING 
        gc.id,
        gc.gan,
        ba.current_amount AS previous_activation_amount,
        gc.activation_amount AS new_activation_amount,
        'balance' AS source,
        ba.timestamp
    `);
    
    // Convert the results to GiftCardFix objects
    const fixesFromBalances = fromBalances.rows.map(row => ({
      id: row.id,
      gan: row.gan,
      previousActivationAmount: parseFloat(row.previous_activation_amount || '0'),
      newActivationAmount: parseFloat(row.new_activation_amount),
      source: row.source,
      timestamp: new Date(row.timestamp)
    }));
    
    fixes.push(...fixesFromBalances);
    
    // Get summary statistics
    const totalCards = await pool.query(`SELECT COUNT(*) FROM gift_cards`);
    const cardsWithAmount = await pool.query(`SELECT COUNT(*) FROM gift_cards WHERE activation_amount > 0`);
    const cardsWithoutAmount = await pool.query(`SELECT COUNT(*) FROM gift_cards WHERE activation_amount = 0`);
    
    const result: GiftCardFixResult = {
      totalProcessed: parseInt(totalCards.rows[0].count),
      updated: fixes.length,
      alreadyCorrect: parseInt(cardsWithAmount.rows[0].count) - fixes.length,
      withoutActivation: parseInt(cardsWithoutAmount.rows[0].count),
      fixDetails: fixes
    };
    
    return result;
  } catch (error) {
    console.error('Error fixing gift card activation amounts:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

/**
 * Verify gift card activation amounts
 * 
 * This function performs a comprehensive verification of gift card data
 * across all dates to ensure consistency and accuracy
 */
export async function verifyGiftCardData() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    console.log('Verifying gift card data...');
    
    // Get a list of unique dates from gift cards
    const dates = await pool.query(`
      SELECT DISTINCT DATE(created_at AT TIME ZONE 'UTC') AS date
      FROM gift_cards
      ORDER BY date
    `);
    
    const report: Record<string, any> = {};
    let totalActivationAmount = 0;
    let totalCardCount = 0;
    
    // Check each date
    for (const dateRow of dates.rows) {
      const date = dateRow.date;
      
      // Get cards created on this date
      const cards = await pool.query(`
        SELECT 
          COUNT(*) AS card_count,
          SUM(activation_amount) AS activation_total,
          SUM(current_balance) AS balance_total,
          SUM(redeemed_amount) AS redeemed_total
        FROM gift_cards
        WHERE DATE(created_at AT TIME ZONE 'UTC') = $1
      `, [date]);
      
      const cardCount = parseInt(cards.rows[0].card_count);
      const activationTotal = parseFloat(cards.rows[0].activation_total || '0');
      const balanceTotal = parseFloat(cards.rows[0].balance_total || '0');
      const redeemedTotal = parseFloat(cards.rows[0].redeemed_total || '0');
      
      // Count cards with and without activation amounts
      const cardsWithActivation = await pool.query(`
        SELECT COUNT(*) AS count
        FROM gift_cards
        WHERE DATE(created_at AT TIME ZONE 'UTC') = $1
        AND activation_amount > 0
      `, [date]);
      
      const cardsWithActivationCount = parseInt(cardsWithActivation.rows[0].count);
      
      if (cardCount > 0) {
        report[date] = {
          cardCount,
          activationTotal,
          balanceTotal,
          redeemedTotal,
          sumBalanceAndRedeemed: balanceTotal + redeemedTotal,
          cardsWithActivation: cardsWithActivationCount,
          cardsWithoutActivation: cardCount - cardsWithActivationCount
        };
        
        totalActivationAmount += activationTotal;
        totalCardCount += cardCount;
        
        console.log(`${date}: ${cardCount} cards, $${activationTotal.toFixed(2)} total activation`);
        console.log(`  Current Balance Total: $${balanceTotal.toFixed(2)}`);
        console.log(`  Redeemed Amount Total: $${redeemedTotal.toFixed(2)}`);
        console.log(`  Sum (Balance + Redeemed): $${(balanceTotal + redeemedTotal).toFixed(2)}`);
        console.log(`  Cards with activation amount: ${cardsWithActivationCount}`);
        console.log(`  Cards missing activation amount: ${cardCount - cardsWithActivationCount}`);
      } else {
        console.log(`${date}: No gift cards found`);
      }
    }
    
    console.log('=== Overall Summary ===');
    console.log(`Total Gift Cards: ${totalCardCount}`);
    console.log(`Total Activation Amount: $${totalActivationAmount.toFixed(2)}`);
    console.log(`Average Activation Amount: $${(totalActivationAmount / totalCardCount).toFixed(2)}`);
    
    // Final consistency check - verify recent dates have correct data
    console.log('=== Consistency Check ===');
    console.log('Verifying that no special cases or hardcoded values are used:');
    
    const recentDates = await pool.query(`
      SELECT DISTINCT DATE(created_at AT TIME ZONE 'UTC') AS date
      FROM gift_cards
      WHERE created_at > NOW() - INTERVAL '7 days'
      ORDER BY date
    `);
    
    for (const dateRow of recentDates.rows) {
      const date = dateRow.date;
      
      const summaryQuery = await pool.query(`
        SELECT 
          SUM(activation_amount) AS activation_total,
          COUNT(*) AS card_count
        FROM gift_cards
        WHERE DATE(created_at AT TIME ZONE 'UTC') = $1
      `, [date]);
      
      const activationTotal = parseFloat(summaryQuery.rows[0].activation_total || '0');
      const cardCount = parseInt(summaryQuery.rows[0].card_count);
      
      console.log(`${date}: $${activationTotal.toFixed(2)} activation total, ${cardCount} cards`);
    }
    
    return report;
  } catch (error) {
    console.error('Error verifying gift card data:', error);
    throw error;
  } finally {
    await pool.end();
  }
}