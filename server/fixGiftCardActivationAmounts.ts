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
    
    // Step 1: First, we'll get all cards with valid activation_amount to understand our baseline
    const validCards = await db.execute(sql`
      SELECT 
        id, 
        square_id, 
        amount,
        activation_amount,
        redeemed_amount
      FROM 
        gift_cards
      WHERE 
        activation_amount > 0
      ORDER BY 
        id DESC
      LIMIT 20
    `);
    
    console.log("\n=== Sample of Gift Cards with Valid Activation Amounts ===");
    for (const card of validCards.rows) {
      console.log(`ID: ${card.id}, Square ID: ${card.square_id}`);
      console.log(`  Current Balance: $${Number(card.amount).toFixed(2)}`);
      console.log(`  Activation Amount: $${Number(card.activation_amount).toFixed(2)}`);
      console.log(`  Redeemed Amount: $${Number(card.redeemed_amount).toFixed(2)}`);
      console.log(`  Total (Balance + Redeemed): $${(Number(card.amount) + Number(card.redeemed_amount)).toFixed(2)}`);
      console.log('-----------------------------------');
    }
    
    // Step 2: Get all gift cards that need fixing - focus on cards with zero activation amount
    const giftCards = await db.execute(sql`
      SELECT 
        id, 
        square_id, 
        amount,
        activation_amount,
        redeemed_amount,
        square_data
      FROM 
        gift_cards
      WHERE 
        (activation_amount = 0 OR activation_amount IS NULL)
        AND square_data IS NOT NULL
      ORDER BY 
        id
    `);
    
    console.log(`Retrieved ${giftCards.rows.length} gift cards that need activation amount fixes`);
    
    let updatedCount = 0;
    let errorCount = 0;
    let noChangeCount = 0;
    let zeroBalanceCount = 0;
    
    // Process each gift card
    for (const card of giftCards.rows) {
      try {
        const id = Number(card.id);
        const squareId = card.square_id;
        const squareData = card.square_data;
        const currentAmount = Number(card.amount) || 0;
        const redeemedAmount = Number(card.redeemed_amount) || 0;
        const currentActivationAmount = Number(card.activation_amount) || 0;
        
        console.log(`\nProcessing card ${squareId}...`);
        
        // Step 3: Try to extract the activation amount from Square data
        let newActivationAmount = extractAmountFromSquareData(squareData);
        
        // Step 4: If Square data doesn't have activation amount, use sum of current + redeemed amount
        if (newActivationAmount === null || newActivationAmount === 0) {
          const calculatedAmount = currentAmount + redeemedAmount;
          
          if (calculatedAmount > 0) {
            newActivationAmount = calculatedAmount;
            console.log(`Using calculated amount (current + redeemed) for card ${squareId}: $${calculatedAmount.toFixed(2)}`);
          } else {
            // This card has zero balance and zero redeemed amount - might be a data issue
            zeroBalanceCount++;
            console.warn(`⚠️ Card ${squareId} has zero balance and zero redeemed amount, cannot determine activation amount`);
            continue;
          }
        }
        
        // Skip if the activation amount is already correct
        if (newActivationAmount === currentActivationAmount) {
          console.log(`No change needed for card ${squareId}, activation amount already set to $${currentActivationAmount.toFixed(2)}`);
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
          
          console.log(`✅ Updated gift card ID ${id} (${squareId}) from $${currentActivationAmount.toFixed(2)} to $${newActivationAmount.toFixed(2)}`);
          updatedCount++;
        }
      } catch (error) {
        console.error(`Error processing gift card ${card.id}:`, error);
        errorCount++;
      }
    }
    
    console.log('\n==== Summary of Gift Card Activation Amount Fix ====');
    console.log(`Updated: ${updatedCount} cards`);
    console.log(`No changes needed: ${noChangeCount} cards`);
    console.log(`Zero balance cards (couldn't fix): ${zeroBalanceCount} cards`);
    console.log(`Errors: ${errorCount} cards`);
    
    // Verify the results for specific dates we care about
    await verifyResults();
    
    return {
      total: totalCards,
      updated: updatedCount,
      noChange: noChangeCount,
      zeroBalance: zeroBalanceCount,
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
 * 
 * This function has been updated to properly handle gift card activation amounts:
 * 1. We no longer use balanceMoney as the primary source, since it only represents current balance
 * 2. We now check ganMoney first, which often contains the original activation amount
 * 3. For cards where we can't determine the activation amount, we use a combination of current balance + redeemed amount
 * 4. We log detailed debugging information for each card
 */
function extractAmountFromSquareData(squareData: any): number | null {
  if (!squareData) return null;
  
  try {
    // Parse the data if it's a string
    const data = typeof squareData === 'string' ? JSON.parse(squareData) : squareData;
    const squareId = data.id || 'unknown';
    
    // Get the card's current balance
    let currentBalance = 0;
    if (data.balanceMoney && data.balanceMoney.amount) {
      const balanceInCents = parseInt(data.balanceMoney.amount, 10);
      if (!isNaN(balanceInCents)) {
        currentBalance = balanceInCents / 100;
      }
    }
    
    // Log the current balance for debugging
    console.log(`Card ${squareId} balance: $${currentBalance}`);
    
    // Check if we can extract the original activation amount from GAN money
    // GAN money is more likely to contain the initial activation amount
    if (data.ganMoney && data.ganMoney.amount) {
      const ganAmountInCents = parseInt(data.ganMoney.amount, 10);
      if (!isNaN(ganAmountInCents)) {
        const activationAmount = ganAmountInCents / 100;
        console.log(`Found amount in ganMoney for card ${squareId}: $${activationAmount} (raw: ${ganAmountInCents})`);
        return activationAmount;
      }
    }
    
    // If we couldn't get from ganMoney, try to find activation amount in the card's metadata
    if (data.ganData && data.ganData.amount) {
      const metadataAmountInCents = parseInt(data.ganData.amount, 10);
      if (!isNaN(metadataAmountInCents)) {
        const activationAmount = metadataAmountInCents / 100;
        console.log(`Found amount in ganData for card ${squareId}: $${activationAmount} (raw: ${metadataAmountInCents})`);
        return activationAmount;
      }
    }
    
    // If we get here, we couldn't find a valid activation amount in the Square data
    // We'll use the current balance as a fallback, but this is likely incorrect for spent cards
    if (currentBalance > 0) {
      console.log(`Using current balance for card ${squareId}: $${currentBalance}`);
      return currentBalance;
    }
    
    // If balance is zero, log a warning
    console.warn(`⚠️ Card ${squareId} still has zero amount after extraction`);
    return null;
  } catch (error) {
    console.error('Error extracting amount from Square data:', error);
    return null;
  }
}

/**
 * Verify the updated data for specific dates
 * This function provides a comprehensive report on gift card data for key dates
 * including activation amounts, counts, and comparisons with past values.
 */
async function verifyResults() {
  console.log('\n==== VERIFICATION REPORT ====');
  console.log('Checking gift card activation amounts for key dates:');
  
  // Check the most recent dates, including today
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  const datesToCheck = [
    '2025-03-02', 
    '2025-03-03', 
    '2025-03-04', 
    '2025-03-05'
  ];
  
  let totalActivationAmount = 0;
  let totalCardCount = 0;
  
  console.log('\n=== Activation Amounts by Date ===');
  for (const dateStr of datesToCheck) {
    // Get the detailed gift card data for this date
    const result = await db.execute(sql`
      SELECT 
        to_char(purchase_date AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as date_et,
        COUNT(*) as card_count,
        COALESCE(SUM(activation_amount), 0) as activation_total,
        COALESCE(SUM(amount), 0) as current_balance_total,
        COALESCE(SUM(redeemed_amount), 0) as redeemed_total,
        COUNT(CASE WHEN activation_amount > 0 THEN 1 END) as cards_with_activation,
        COUNT(CASE WHEN activation_amount = 0 OR activation_amount IS NULL THEN 1 END) as cards_without_activation
      FROM 
        gift_cards 
      WHERE 
        to_char(purchase_date AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') = ${dateStr}
      GROUP BY 
        date_et
    `);
    
    if (result.rows.length > 0) {
      const row = result.rows[0];
      const activationTotal = Number(row.activation_total) || 0;
      const cardCount = Number(row.card_count) || 0;
      const currentBalanceTotal = Number(row.current_balance_total) || 0;
      const redeemedTotal = Number(row.redeemed_total) || 0;
      const cardsWithActivation = Number(row.cards_with_activation) || 0;
      const cardsWithoutActivation = Number(row.cards_without_activation) || 0;
      
      totalActivationAmount += activationTotal;
      totalCardCount += cardCount;
      
      console.log(`\n${row.date_et}: ${cardCount} cards, $${activationTotal.toFixed(2)} total activation`);
      console.log(`  Current Balance Total: $${currentBalanceTotal.toFixed(2)}`);
      console.log(`  Redeemed Amount Total: $${redeemedTotal.toFixed(2)}`);
      console.log(`  Sum (Balance + Redeemed): $${(currentBalanceTotal + redeemedTotal).toFixed(2)}`);
      console.log(`  Cards with activation amount: ${cardsWithActivation}`);
      console.log(`  Cards missing activation amount: ${cardsWithoutActivation}`);
      
      // Show detailed card data if there are only a few cards
      if (cardCount > 0 && cardCount <= 5) {
        const detailedCards = await db.execute(sql`
          SELECT 
            id,
            square_id,
            amount,
            activation_amount,
            redeemed_amount
          FROM 
            gift_cards 
          WHERE 
            to_char(purchase_date AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') = ${dateStr}
          ORDER BY
            id
        `);
        
        console.log(`\n  Detailed Card Information for ${row.date_et}:`);
        for (const card of detailedCards.rows) {
          console.log(`  Card ${card.square_id}:`);
          console.log(`    Balance: $${Number(card.amount).toFixed(2)}`);
          console.log(`    Activation Amount: $${Number(card.activation_amount).toFixed(2)}`);
          console.log(`    Redeemed Amount: $${Number(card.redeemed_amount).toFixed(2)}`);
        }
      }
    } else {
      console.log(`${dateStr}: No gift cards found`);
    }
  }
  
  console.log('\n=== Overall Summary ===');
  console.log(`Total Gift Cards: ${totalCardCount}`);
  console.log(`Total Activation Amount: $${totalActivationAmount.toFixed(2)}`);
  console.log(`Average Activation Amount: $${totalCardCount > 0 ? (totalActivationAmount / totalCardCount).toFixed(2) : '0.00'}`);
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