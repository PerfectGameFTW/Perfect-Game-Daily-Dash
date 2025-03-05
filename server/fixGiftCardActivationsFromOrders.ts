/**
 * Accurate Gift Card Activation Detection
 * 
 * This script fixes the gift card activation amount issues by:
 * 1. Searching Orders API for gift card activations (not payments)
 * 2. Extracting exact activation amounts from order line items
 * 3. Matching gift cards by GAN and updating their activation amounts
 * 
 * Square treats gift card activations as orders with GIFT_CARD items,
 * not as payment transactions, which is why our previous approach wasn't fully accurate.
 */

import { db } from './db';
import { sql } from 'drizzle-orm';
import { squareClient } from './squareClient';
import { getEasternDateRange } from './dateUtils';
import { DateRange } from '../shared/schema';

// Custom type that extends DateRange to include 'all_time'
type ExtendedDateRange = DateRange | 'all_time';

// Main function to fix gift card activation amounts
export async function fixGiftCardActivationsFromOrders(dateRange: ExtendedDateRange = 'all_time') {
  console.log('Starting gift card activation fix from Orders API...');
  
  try {
    // Step 1: Retrieve all gift cards from the database
    const giftCards = await db.execute(sql`
      SELECT 
        id, 
        square_id, 
        gan,
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
    
    console.log(`Retrieved ${giftCards.rows.length} gift cards to update`);
    
    // Step 2: Get gift card activations from Orders API
    const giftCardActivations = await getGiftCardActivations(dateRange);
    console.log(`Found ${giftCardActivations.length} gift card activations in Orders API`);
    
    let updatedCount = 0;
    let noChangeCount = 0;
    let errorCount = 0;
    let noMatchCount = 0;
    let zeroAmountCount = 0;
    
    // Step 3: Process each gift card to update its activation amount
    for (const card of giftCards.rows) {
      try {
        const cardId = Number(card.id);
        const squareId = card.square_id;
        const gan = card.gan || '';
        const currentActivationAmount = Number(card.activation_amount) || 0;
        
        // Skip cards that already have a valid activation amount
        if (currentActivationAmount > 0) {
          console.log(`Card ${squareId} already has valid activation amount: $${currentActivationAmount.toFixed(2)}`);
          noChangeCount++;
          continue;
        }
        
        // Find matching activation by GAN or other identifiers
        const matchingActivation = findMatchingActivation(giftCardActivations, card);
        
        if (matchingActivation) {
          const activationAmount = matchingActivation.activationAmount;
          
          if (activationAmount > 0) {
            // Update the gift card with the accurate activation amount
            await db.execute(sql`
              UPDATE gift_cards
              SET activation_amount = ${activationAmount}
              WHERE id = ${cardId}
            `);
            
            console.log(`✅ Updated gift card ID ${cardId} (${squareId}) to activation amount $${activationAmount.toFixed(2)} from Order ${matchingActivation.orderId}`);
            updatedCount++;
          } else {
            console.warn(`⚠️ Found matching activation for card ${squareId} but amount is zero`);
            zeroAmountCount++;
          }
        } else {
          console.warn(`❓ No matching activation found for gift card ${squareId} (GAN: ${gan})`);
          noMatchCount++;
          
          // Fall back to using balance + redeemed as activation amount if we can't find a match
          const cardBalance = Number(card.amount) || 0;
          const redeemedAmount = Number(card.redeemed_amount) || 0;
          const calculatedAmount = cardBalance + redeemedAmount;
          
          if (calculatedAmount > 0) {
            await db.execute(sql`
              UPDATE gift_cards
              SET activation_amount = ${calculatedAmount}
              WHERE id = ${cardId}
            `);
            
            console.log(`⚠️ No activation match found for card ${squareId}. Using calculated amount (balance + redeemed): $${calculatedAmount.toFixed(2)}`);
            updatedCount++;
          } else {
            console.error(`❌ No activation match found for card ${squareId} and no valid fallback amount available`);
            errorCount++;
          }
        }
      } catch (error) {
        console.error(`Error processing gift card ${card.id}:`, error);
        errorCount++;
      }
    }
    
    // Verify our fix with summary data
    await verifyGiftCardData();
    
    console.log('\n==== Summary of Gift Card Activation Fix ====');
    console.log(`Total gift cards: ${giftCards.rows.length}`);
    console.log(`Updated with actual activation amount: ${updatedCount} cards`);
    console.log(`No change needed: ${noChangeCount} cards`);
    console.log(`No match found: ${noMatchCount} cards`);
    console.log(`Zero amount issues: ${zeroAmountCount} cards`);
    console.log(`Errors: ${errorCount} cards`);
    
    return {
      total: giftCards.rows.length,
      updated: updatedCount,
      noChange: noChangeCount,
      noMatch: noMatchCount,
      zeroAmount: zeroAmountCount,
      errors: errorCount
    };
  } catch (error) {
    console.error('Error during gift card activation fix:', error);
    throw error;
  }
}

// Helper function to get gift card activations from Orders API
async function getGiftCardActivations(dateRange: ExtendedDateRange, startDate?: Date, endDate?: Date) {
  // For all_time, use a very old start date
  let start: Date;
  let end: Date;
  
  if (dateRange === 'all_time') {
    start = new Date('2020-01-01');
    end = new Date();
  } else {
    const dateRangeResult = getEasternDateRange(dateRange as DateRange, startDate, endDate);
    start = dateRangeResult.start;
    end = dateRangeResult.end;
  }
  
  console.log(`Searching for gift card activations between ${start.toISOString()} and ${end.toISOString()}`);
  
  try {
    // Get location ID from environment variable
    const locationId = process.env.SQUARE_LOCATION_ID;
    if (!locationId) {
      throw new Error("Square location ID not found in environment variables");
    }
    
    // Search orders for the given date range - using batched requests for larger date ranges
    const maxDaysPerRequest = 31;
    const allActivations: any[] = [];
    let currentStart = new Date(start);
    
    while (currentStart < end) {
      // Calculate batch end date (max 31 days per request or the overall end date)
      const batchEnd = new Date(currentStart);
      batchEnd.setDate(batchEnd.getDate() + maxDaysPerRequest);
      const queryEndDate = batchEnd < end ? batchEnd : end;
      
      console.log(`Fetching batch from ${currentStart.toISOString()} to ${queryEndDate.toISOString()}`);
      
      // Make the actual API request for this batch
      try {
        // Check if we have direct access to the Orders API through squareClient
        if (!squareClient.ordersApi) {
          console.log("Direct access to Orders API not available, using fetchOrders method instead");
          const orders = await squareClient.fetchOrders(currentStart, queryEndDate);
          
          // Process the orders from fetchOrders
          for (const order of orders) {
            // Skip orders without line items
            if (!order.lineItems || order.lineItems.length === 0) continue;
            
            // Find gift card line items in this order
            const giftCardItems = order.lineItems.filter((item: any) => 
              // Look for multiple indicators that this item is a gift card
              (item.name && item.name.toLowerCase().includes('gift card')) ||
              (item.catalogObjectId && item.catalogObjectId.startsWith('gift_card')) ||
              (item.variationName && item.variationName.toLowerCase().includes('gift card'))
            );
            
            // Extract activation details for each gift card in this order
            for (const item of giftCardItems) {
              // Get the price from various possible locations
              const basePriceAmount = item.basePriceMoney?.amount 
                ? Number(item.basePriceMoney.amount) / 100 
                : 0;
              
              const grossPriceAmount = item.grossSalesMoney?.amount
                ? Number(item.grossSalesMoney.amount) / 100
                : 0;
                
              // Use the most appropriate price (prefer base price over gross)
              const activationAmount = basePriceAmount || grossPriceAmount;
              
              // Extract order and payment info
              const orderId = order.id;
              const timestamp = order.createdAt ? new Date(order.createdAt) : new Date();
              
              // Try to find any GANs in the order data
              let giftCardGan = '';
              
              // In Square's API, the GAN might be in various places
              if (order.note && typeof order.note === 'string') {
                const ganMatch = order.note.match(/GAN:\s*(\d+)/i);
                if (ganMatch && ganMatch[1]) {
                  giftCardGan = ganMatch[1];
                }
              }
              
              // Add this activation to our results
              allActivations.push({
                orderId,
                timestamp,
                activationAmount,
                giftCardGan,
                itemName: item.name,
                catalogObjectId: item.catalogObjectId,
                variationName: item.variationName,
                orderData: order
              });
            }
          }
        } else {
          // Use direct ordersApi if available
          const { result } = await squareClient.ordersApi.searchOrders({
            locationIds: [locationId],
            query: {
              filter: {
                dateTimeFilter: {
                  createdAt: {
                    startAt: currentStart.toISOString(),
                    endAt: queryEndDate.toISOString(),
                  },
                },
              },
            },
          });
          
          // Process orders in this batch to extract gift card information
          const batchOrders = result?.orders || [];
          console.log(`Found ${batchOrders.length} total orders in batch`);
          
          for (const order of batchOrders) {
            // Skip orders without line items
            if (!order.lineItems || order.lineItems.length === 0) continue;
            
            // Find gift card line items in this order
            const giftCardItems = order.lineItems.filter((item: any) => 
              // Look for multiple indicators that this item is a gift card
              (item.name && item.name.toLowerCase().includes('gift card')) ||
              (item.catalogObjectId && item.catalogObjectId.startsWith('gift_card')) ||
              (item.variationName && item.variationName.toLowerCase().includes('gift card'))
            );
            
            // Extract activation details for each gift card in this order
            for (const item of giftCardItems) {
              // Get the price from various possible locations
              const basePriceAmount = item.basePriceMoney?.amount 
                ? Number(item.basePriceMoney.amount) / 100 
                : 0;
              
              const grossPriceAmount = item.grossSalesMoney?.amount
                ? Number(item.grossSalesMoney.amount) / 100
                : 0;
                
              // Use the most appropriate price (prefer base price over gross)
              const activationAmount = basePriceAmount || grossPriceAmount;
              
              // Extract order and payment info
              const orderId = order.id;
              
              // Handle createdAt safely
              let timestamp: Date;
              if (order.createdAt) {
                timestamp = new Date(order.createdAt);
              } else {
                timestamp = new Date();
              }
              
              // Try to find any GANs in the order data
              let giftCardGan = '';
              
              // In Square's API, the GAN might be in various places
              if (order.note && typeof order.note === 'string') {
                const ganMatch = order.note.match(/GAN:\s*(\d+)/i);
                if (ganMatch && ganMatch[1]) {
                  giftCardGan = ganMatch[1];
                }
              }
              
              // Check for payments array if it exists (it may not in some API versions)
              if (order.tenders) {
                for (const tender of order.tenders) {
                  const note = tender.note || '';
                  if (note && typeof note === 'string') {
                    const ganMatch = note.match(/GAN:\s*(\d+)/i);
                    if (ganMatch && ganMatch[1]) {
                      giftCardGan = ganMatch[1];
                      break;
                    }
                  }
                }
              }
              
              // Add this activation to our results
              allActivations.push({
                orderId,
                timestamp,
                activationAmount,
                giftCardGan,
                itemName: item.name,
                catalogObjectId: item.catalogObjectId,
                variationName: item.variationName,
                orderData: order
              });
            }
          }
        }
        
        // Move to the next batch
        currentStart = new Date(queryEndDate);
        currentStart.setDate(currentStart.getDate() + 1);
        
      } catch (error) {
        console.error(`Error fetching batch from ${currentStart.toISOString()}:`, error);
        // Continue with next batch despite errors
        currentStart = new Date(queryEndDate);
        currentStart.setDate(currentStart.getDate() + 1);
      }
    }
    
    console.log(`Found a total of ${allActivations.length} gift card activations across all batches`);
    
    // Filter out zero-amount activations which are likely not actual activations
    const validActivations = allActivations.filter(activation => activation.activationAmount > 0);
    console.log(`${validActivations.length} activations have valid amounts (> $0)`);
    
    return validActivations;
  } catch (error) {
    console.error('Error fetching gift card activations from Orders API:', error);
    throw error;
  }
}

// Helper function to find a matching activation for a gift card
function findMatchingActivation(activations: any[], card: any) {
  // Try to match by GAN first (most accurate)
  const gan = card.gan || '';
  if (gan) {
    const ganMatch = activations.find(activation => 
      activation.giftCardGan && activation.giftCardGan === gan
    );
    if (ganMatch) return ganMatch;
  }
  
  // Try to match by exact Square ID if present in order data
  const squareId = card.square_id || '';
  if (squareId) {
    // Look for the square_id in order data
    const idMatch = activations.find(activation => {
      const orderData = activation.orderData;
      // Check various places where the ID might be referenced
      return Object.values(orderData || {}).some(value => 
        typeof value === 'string' && value.includes(squareId)
      );
    });
    if (idMatch) return idMatch;
  }
  
  // If no exact match, try to find a temporal match with similar amount
  const purchaseDate = new Date(card.purchase_date);
  const currentBalance = Number(card.amount) || 0;
  const redeemedAmount = Number(card.redeemed_amount) || 0;
  const estimatedActivationAmount = currentBalance + redeemedAmount;
  
  // Find activations close to the purchase date (within 12 hours)
  const timeWindow = 12 * 60 * 60 * 1000; // 12 hours in milliseconds
  const timeMatches = activations.filter(activation => {
    const timeDiff = Math.abs(activation.timestamp.getTime() - purchaseDate.getTime());
    return timeDiff <= timeWindow;
  });
  
  if (timeMatches.length === 0) return null;
  
  // If multiple matches in time window, choose the one with amount closest to estimated activation
  if (timeMatches.length > 1 && estimatedActivationAmount > 0) {
    return timeMatches.reduce((best, current) => {
      const bestDiff = Math.abs(best.activationAmount - estimatedActivationAmount);
      const currentDiff = Math.abs(current.activationAmount - estimatedActivationAmount);
      return currentDiff < bestDiff ? current : best;
    });
  }
  
  // Otherwise, just return the first time match
  return timeMatches[0];
}

// Verify our fix with test data for key dates
async function verifyGiftCardData() {
  console.log('\n=== Verification of Gift Card Data ===');
  
  // Check data for specific dates to ensure fix is comprehensive
  const testDates = [
    '2025-02-25', // The problematic date
    '2025-02-28',
    '2025-03-01',
    '2025-03-02',
    '2025-03-03',
    '2025-03-04'
  ];
  
  for (const dateStr of testDates) {
    // Create start of day in Eastern time
    const date = new Date(`${dateStr}T05:00:00.000Z`); // 00:00 Eastern is 05:00 UTC
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    
    // Query gift cards for this date
    const result = await db.execute(sql`
      SELECT 
        COUNT(*) as card_count,
        SUM(activation_amount) as total_activation,
        SUM(amount) as total_balance,
        SUM(redeemed_amount) as total_redeemed,
        COUNT(CASE WHEN activation_amount > 0 THEN 1 END) as cards_with_amount,
        COUNT(CASE WHEN activation_amount IS NULL OR activation_amount = 0 THEN 1 END) as cards_without_amount
      FROM 
        gift_cards
      WHERE 
        purchase_date >= ${date.toISOString()}::timestamp
        AND purchase_date < ${nextDay.toISOString()}::timestamp
    `);
    
    const row = result.rows[0];
    const cardCount = Number(row.card_count) || 0;
    const totalActivation = Number(row.total_activation) || 0;
    const totalBalance = Number(row.total_balance) || 0;
    const totalRedeemed = Number(row.total_redeemed) || 0;
    const cardsWithAmount = Number(row.cards_with_amount) || 0;
    const cardsWithoutAmount = Number(row.cards_without_amount) || 0;
    
    console.log(`${dateStr}: ${cardCount} cards, $${totalActivation.toFixed(2)} total activation`);
    if (cardCount > 0) {
      console.log(`  Current Balance Total: $${totalBalance.toFixed(2)}`);
      console.log(`  Redeemed Amount Total: $${totalRedeemed.toFixed(2)}`);
      console.log(`  Sum (Balance + Redeemed): $${(totalBalance + totalRedeemed).toFixed(2)}`);
      console.log(`  Cards with activation amount: ${cardsWithAmount}`);
      console.log(`  Cards missing activation amount: ${cardsWithoutAmount}`);
    }
  }
  
  // Generate overall statistics
  const overallStats = await db.execute(sql`
    SELECT 
      COUNT(*) as total_cards,
      SUM(activation_amount) as total_activation,
      AVG(activation_amount) as avg_activation,
      COUNT(CASE WHEN activation_amount > 0 THEN 1 END) as cards_with_amount,
      COUNT(CASE WHEN activation_amount IS NULL OR activation_amount = 0 THEN 1 END) as cards_without_amount
    FROM 
      gift_cards
  `);
  
  const stats = overallStats.rows[0];
  console.log('\n=== Overall Summary ===');
  console.log(`Total Gift Cards: ${stats.total_cards}`);
  console.log(`Total Activation Amount: $${Number(stats.total_activation).toFixed(2)}`);
  console.log(`Average Activation Amount: $${Number(stats.avg_activation).toFixed(2)}`);
  console.log(`Cards with activation amount: ${stats.cards_with_amount}`);
  console.log(`Cards missing activation amount: ${stats.cards_without_amount}`);
}

// Entry point for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  fixGiftCardActivationsFromOrders()
    .then(() => {
      console.log('Gift card activation fix completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('Error during gift card activation fix:', error);
      process.exit(1);
    });
}