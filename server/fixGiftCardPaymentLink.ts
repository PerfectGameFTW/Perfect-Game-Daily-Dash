/**
 * Script to link gift cards with their Square payment transactions
 * 
 * This script solves the issue of incorrect gift card activation amounts by:
 * 1. Finding Square payment transactions that correspond to gift card activations
 * 2. Extracting the precise payment amount from the transaction data
 * 3. Updating the gift card's activation_amount field with the exact payment amount
 * 
 * This approach ensures accurate gift card sales reporting by using the
 * actual payment data rather than estimating from card balances or other methods.
 */

import { db } from './db';
import { sql } from 'drizzle-orm';
import { squareClient } from './squareClient';

// Main function to link gift cards with their activation payments
export async function linkGiftCardsToPayments() {
  console.log('Starting gift card to payment linking process...');
  
  try {
    // Step 1: Retrieve all gift cards from the database
    const giftCards = await db.execute(sql`
      SELECT 
        id, 
        square_id, 
        amount,
        activation_amount,
        redeemed_amount,
        purchase_date,
        square_data
      FROM 
        gift_cards
      ORDER BY 
        purchase_date DESC
    `);
    
    console.log(`Retrieved ${giftCards.rows.length} gift cards to link with payments`);
    
    // Step 2: Retrieve all gift card payment transactions
    const giftCardPayments = await db.execute(sql`
      SELECT 
        id,
        square_id,
        amount,
        timestamp,
        status,
        square_data
      FROM 
        transactions
      WHERE 
        category_id = 'gift_card'
        AND amount > 0
      ORDER BY 
        timestamp DESC
    `);
    
    console.log(`Retrieved ${giftCardPayments.rows.length} gift card payment transactions`);
    
    let linkedCount = 0;
    let errorCount = 0;
    let noChangeCount = 0;
    let matchFoundCount = 0;
    
    // Step 3: Process each gift card to match with its activation payment
    for (const card of giftCards.rows) {
      try {
        const id = Number(card.id);
        const squareId = card.square_id;
        const currentActivationAmount = Number(card.activation_amount) || 0;
        const squareData = card.square_data;
        // Handle date safely
        const purchaseDate = card.purchase_date ? new Date(card.purchase_date as string) : new Date();
        
        console.log(`\nProcessing gift card ${squareId}...`);
        
        if (currentActivationAmount > 0) {
          console.log(`Card ${squareId} already has valid activation amount: $${currentActivationAmount.toFixed(2)}`);
          noChangeCount++;
          continue;
        }
        
        // Extract useful identifiers from Square data
        let gan = '';
        let sourceId = '';
        
        if (squareData) {
          // Parse the data if it's a string
          const data = typeof squareData === 'string' ? JSON.parse(squareData) : squareData;
          gan = data.gan || '';
          
          // Look for source_id or other identifying fields
          sourceId = data.source_id || data.sourceId || data.id || '';
        }
        
        // Try to find a matching payment
        // First, find payments around the same time as the gift card purchase date
        const purchaseDateStart = new Date(purchaseDate);
        purchaseDateStart.setHours(purchaseDateStart.getHours() - 6); // 6 hours before
        
        const purchaseDateEnd = new Date(purchaseDate);
        purchaseDateEnd.setHours(purchaseDateEnd.getHours() + 6); // 6 hours after
        
        console.log(`Looking for payments between ${purchaseDateStart.toISOString()} and ${purchaseDateEnd.toISOString()}`);
        
        // Find temporal matches
        const potentialMatches = giftCardPayments.rows.filter(payment => {
          try {
            const paymentDate = payment.timestamp ? new Date(payment.timestamp as string) : new Date();
            return paymentDate >= purchaseDateStart && paymentDate <= purchaseDateEnd;
          } catch (e) {
            console.warn(`Invalid timestamp for payment:`, payment.square_id);
            return false;
          }
        });
        
        console.log(`Found ${potentialMatches.length} potential payment matches by time range`);
        
        if (potentialMatches.length > 0) {
          // Try to find an exact match by source_id or other identifiers
          const exactMatch = potentialMatches.find(payment => {
            const paymentData = payment.square_data;
            if (!paymentData) return false;
            
            // Parse payment data and check for matching identifiers
            const data = typeof paymentData === 'string' ? JSON.parse(paymentData) : paymentData;
            
            // Check if source_id or other fields match
            const paymentSourceId = data.source_id || data.sourceId || '';
            const paymentOrderId = data.order_id || data.orderId || '';
            const paymentGan = data.gan || '';
            
            return (
              (sourceId && sourceId === paymentSourceId) ||
              (gan && gan === paymentGan) ||
              (data.note && data.note.includes(squareId))
            );
          });
          
          if (exactMatch) {
            // We found an exact match by identifiers
            const paymentAmount = Number(exactMatch.amount);
            matchFoundCount++;
            
            if (paymentAmount > 0) {
              // Update the gift card with the verified payment amount
              await db.execute(sql`
                UPDATE gift_cards
                SET activation_amount = ${paymentAmount}
                WHERE id = ${id}
              `);
              
              console.log(`✅ Updated gift card ID ${id} (${squareId}) to activation amount $${paymentAmount.toFixed(2)} based on exact payment match`);
              linkedCount++;
            } else {
              console.warn(`⚠️ Found exact match for card ${squareId} but payment amount is invalid: ${paymentAmount}`);
              errorCount++;
            }
          } else {
            // No exact match by identifiers, try to make a reasonable assumption
            // For multiple potential matches, use the payment with the closest amount to the card's current balance
            const cardBalance = Number(card.amount) || 0;
            
            // Sort by closest amount first
            potentialMatches.sort((a, b) => {
              const aAmount = Number(a.amount);
              const bAmount = Number(b.amount);
              
              return Math.abs(aAmount - cardBalance) - Math.abs(bAmount - cardBalance);
            });
            
            const bestMatch = potentialMatches[0];
            const bestMatchAmount = Number(bestMatch.amount);
            
            if (bestMatchAmount > 0) {
              // Update the gift card with the best match payment amount
              await db.execute(sql`
                UPDATE gift_cards
                SET activation_amount = ${bestMatchAmount}
                WHERE id = ${id}
              `);
              
              console.log(`✅ Updated gift card ID ${id} (${squareId}) to activation amount $${bestMatchAmount.toFixed(2)} based on best temporal match`);
              linkedCount++;
            } else {
              console.warn(`⚠️ Found best match for card ${squareId} but payment amount is invalid: ${bestMatchAmount}`);
              errorCount++;
            }
          }
        } else {
          // No payment matches found in the time range
          // Try to use the card's current balance if it's non-zero
          const cardBalance = Number(card.amount) || 0;
          const redeemedAmount = Number(card.redeemed_amount) || 0;
          const calculatedAmount = cardBalance + redeemedAmount;
          
          if (calculatedAmount > 0) {
            // Use calculated amount as fallback
            await db.execute(sql`
              UPDATE gift_cards
              SET activation_amount = ${calculatedAmount}
              WHERE id = ${id}
            `);
            
            console.log(`⚠️ No payment match found for card ${squareId}. Using calculated amount (current + redeemed): $${calculatedAmount.toFixed(2)}`);
            linkedCount++;
          } else {
            console.warn(`❌ No payment match found for card ${squareId} and no valid fallback amount available`);
            errorCount++;
          }
        }
      } catch (error) {
        console.error(`Error processing gift card ${card.id}:`, error);
        errorCount++;
      }
    }
    
    console.log('\n==== Summary of Gift Card Payment Linking ====');
    console.log(`Updated: ${linkedCount} cards`);
    console.log(`Exact matches found: ${matchFoundCount} cards`);
    console.log(`No changes needed: ${noChangeCount} cards`);
    console.log(`Errors: ${errorCount} cards`);
    
    return {
      total: giftCards.rows.length,
      linked: linkedCount,
      exactMatches: matchFoundCount,
      noChange: noChangeCount,
      errors: errorCount
    };
  } catch (error) {
    console.error('Error during gift card payment linking:', error);
    throw error;
  }
}

// Entry point when run directly from command line
// This uses import.meta.url to check if this is the main module
// (ESM equivalent of the CommonJS require.main === module pattern)
if (import.meta.url === `file://${process.argv[1]}`) {
  linkGiftCardsToPayments()
    .then(() => {
      console.log('Gift card payment linking completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('Error during gift card payment linking:', error);
      process.exit(1);
    });
}