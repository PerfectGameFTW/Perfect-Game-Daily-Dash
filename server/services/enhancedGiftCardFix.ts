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

import { db, sql } from '../db';
import { giftCards, orders, transactions } from '@shared/schema';
import { and, count, eq, isNull } from 'drizzle-orm';
import { fetchOrders, fetchGiftCards, fetchGiftCardActivitiesMap } from '../squareClient';
import { pgStorage } from '../pgStorage';

// Import the GiftCard type directly from schema
import type { GiftCard as GiftCardType, Order } from '@shared/schema';

// Define the Square order interface shape with required properties
interface SquareOrder {
  id: string;
  createdAt: string;
  lineItems?: Array<{
    name?: string;
    note?: string;
    variationName?: string;
    catalogObjectId?: string;
    basePriceMoney?: {
      amount?: number;
    };
    totalMoney?: {
      amount?: number;
    };
  }>;
}

// Map JavaScript property names to database column names
const DB_COLUMNS = {
  // Gift Cards
  activationAmount: 'activation_amount',
  activationOrderId: 'activation_order_id',
  activationSquareOrderId: 'activation_square_order_id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  
  // Orders
  squareId: 'square_id'
};

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
  console.log('Starting comprehensive gift card activation amount fix...');
  
  // 1. Get all gift cards from database
  const allGiftCards = await db.select().from(giftCards);
  console.log(`Found ${allGiftCards.length} gift cards in database`);
  
  // 2. Fetch fresh order and gift card data from Square API
  // Use a much longer date range (2 years) to ensure we capture all historical gift card activations
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  
  console.log(`Fetching orders with extended date range: ${twoYearsAgo.toISOString()} to ${new Date().toISOString()}`);
  const squareOrders = await fetchOrders(twoYearsAgo);
  console.log(`Fetched ${squareOrders.length} orders from Square API`);
  
  const squareGiftCards = await fetchGiftCards();
  console.log(`Fetched ${squareGiftCards.length} gift cards from Square API`);
  
  // 3. Process each gift card
  const result: GiftCardFixResult = {
    totalProcessed: allGiftCards.length,
    updated: 0,
    alreadyCorrect: 0,
    withoutActivation: 0,
    details: []
  };
  
  for (const giftCard of allGiftCards) {
    try {
      // Two conditions for skipping:
      // 1. Cards with proper activation amount and order link
      // 2. EXCEPT cards with suspicious $50 activation_amount + $0 amount pattern (these need fixing)
      if (
        giftCard.activationAmount !== null && 
        giftCard.activationAmount > 0 && 
        giftCard.activationAmount !== 50 && // Default value often used
        giftCard.activationOrderId !== null
      ) {
        result.alreadyCorrect++;
        continue;
      }
      
      // Specifically target the suspicious pattern cards - default $50 activation amounts with $0 balance
      if (giftCard.activationAmount === 50 && giftCard.amount === 0) {
        console.log(`Found suspicious gift card ${giftCard.id} with $50 activation_amount and $0 balance - will attempt to fix`);
      }
      
      // 3a. Try to match by Square Order ID if available
      if (giftCard.activationSquareOrderId) {
        const matchingOrder = squareOrders.find(order => 
          order.id === giftCard.activationSquareOrderId
        );
        
        if (matchingOrder) {
          // Extract correct activation amount from order
          // Handle potential null gan with optional chaining and nullish coalescing
          const orderAmount = extractGiftCardAmountFromOrder(matchingOrder, giftCard.gan || undefined);
          
          if (orderAmount > 0) {
            // Get or create order in our database
            const orderFromDb = await getOrCreateOrderInDb(matchingOrder);
            
            // Update gift card with accurate amount and order link
            await updateGiftCardActivation(
              giftCard.id, 
              orderAmount, 
              orderFromDb.id,
              matchingOrder.id
            );
            
            result.updated++;
            result.details.push({
              id: giftCard.id,
              gan: giftCard.gan || '',  // Use empty string for null gan
              previousAmount: giftCard.activationAmount || 0,
              newAmount: orderAmount,
              source: 'Square Order ID direct match',
              orderId: orderFromDb.id,
              orderTimestamp: new Date(matchingOrder.createdAt),
              squareOrderId: matchingOrder.id
            });
            
            continue;
          }
        }
      }
      
      // 3b. Try to match by GAN (gift card number) in order line items
      const orderWithGan = squareOrders.find(order => {
        // Check if this order contains a line item with this gift card's GAN
        return order.lineItems?.some((item: any) => {
          return item.note?.includes(giftCard.gan) || 
                 item.variationName?.includes(giftCard.gan) ||
                 item.name?.includes(giftCard.gan);
        });
      });
      
      if (orderWithGan) {
        // Extract correct activation amount from order
        const orderAmount = extractGiftCardAmountFromOrder(orderWithGan, giftCard.gan || undefined);
        
        if (orderAmount > 0) {
          // Get or create order in our database
          const orderFromDb = await getOrCreateOrderInDb(orderWithGan);
          
          // Update gift card with accurate amount and order link
          await updateGiftCardActivation(
            giftCard.id, 
            orderAmount, 
            orderFromDb.id,
            orderWithGan.id
          );
          
          result.updated++;
          result.details.push({
            id: giftCard.id,
            gan: giftCard.gan || '',
            previousAmount: giftCard.activationAmount || 0,
            newAmount: orderAmount,
            source: 'GAN match in order line items',
            orderId: orderFromDb.id,
            orderTimestamp: new Date(orderWithGan.createdAt),
            squareOrderId: orderWithGan.id
          });
          
          continue;
        }
      }
      
      // 3c. Try temporal matching (order within 15 minutes of gift card creation)
      const giftCardTime = new Date(giftCard.createdAt).getTime();
      const ordersWithinTimeWindow = squareOrders.filter(order => {
        const orderTime = new Date(order.createdAt).getTime();
        const timeDifference = Math.abs(orderTime - giftCardTime);
        return timeDifference < 15 * 60 * 1000; // 15 minutes in milliseconds
      });
      
      // Further filter to only orders that have gift card line items
      const giftCardOrdersInTimeWindow = ordersWithinTimeWindow.filter(order => {
        return order.lineItems?.some((item: any) => 
          item.name?.toLowerCase().includes('gift') ||
          item.name?.toLowerCase().includes('cards') ||
          item.catalogObjectId?.toLowerCase().includes('gift')
        );
      });
      
      if (giftCardOrdersInTimeWindow.length > 0) {
        // Sort by closest time match
        giftCardOrdersInTimeWindow.sort((a, b) => {
          const timeA = Math.abs(new Date(a.createdAt).getTime() - giftCardTime);
          const timeB = Math.abs(new Date(b.createdAt).getTime() - giftCardTime);
          return timeA - timeB;
        });
        
        // Get closest matching order
        const bestMatch = giftCardOrdersInTimeWindow[0];
        
        // Extract correct activation amount from closest time-matching order
        const orderAmount = extractGiftCardAmountFromOrder(bestMatch, giftCard.gan || undefined);
        
        if (orderAmount > 0) {
          // Get or create order in our database
          const orderFromDb = await getOrCreateOrderInDb(bestMatch);
          
          // Update gift card with accurate amount and order link
          await updateGiftCardActivation(
            giftCard.id, 
            orderAmount, 
            orderFromDb.id,
            bestMatch.id
          );
          
          result.updated++;
          result.details.push({
            id: giftCard.id,
            gan: giftCard.gan || '',
            previousAmount: giftCard.activationAmount || 0,
            newAmount: orderAmount,
            source: 'Temporal match (within 15 minutes)',
            orderId: orderFromDb.id,
            orderTimestamp: new Date(bestMatch.createdAt),
            squareOrderId: bestMatch.id
          });
          
          continue;
        }
      }
      
      // 3d. If all else fails, mark as needing manual attention
      result.withoutActivation++;
      
    } catch (error) {
      console.error(`Error processing gift card ${giftCard.id}:`, error);
      result.withoutActivation++;
    }
  }
  
  console.log(`Gift card fix completed: ${result.updated} updated, ${result.alreadyCorrect} already correct, ${result.withoutActivation} without activation`);
  
  return result;
}

/**
 * Backfill gift card activation amounts using Square's Gift Card Activities API.
 *
 * This is the PREFERRED repair function.  It fetches all ACTIVATE events directly
 * from Square, which always contain the exact original load amount regardless of
 * whether the card has been spent or not.  Cards not found via the Activities API
 * fall back to the order-matching strategy in fixAllGiftCardActivationAmounts().
 *
 * Returns a summary of how many cards were updated.
 */
export async function backfillGiftCardActivationAmounts(): Promise<{
  totalCards: number;
  updatedViaActivitiesApi: number;
  updatedViaOrderMatch: number;
  stillUnresolved: number;
}> {
  console.log('Starting backfill of gift card activation amounts via Activities API...');

  // 1. Fetch all cards from DB that need repair (null or zero activation amount)
  const result = await db.execute(sql`
    SELECT id, square_id, gan, activation_amount
    FROM gift_cards
    WHERE activation_amount IS NULL OR activation_amount = 0
    ORDER BY id
  `);
  const cardsNeedingRepair = result.rows as Array<{
    id: number;
    square_id: string;
    gan: string | null;
    activation_amount: number | null;
  }>;

  console.log(`${cardsNeedingRepair.length} gift cards need activation amount repair`);

  if (cardsNeedingRepair.length === 0) {
    return { totalCards: 0, updatedViaActivitiesApi: 0, updatedViaOrderMatch: 0, stillUnresolved: 0 };
  }

  // 2. Fetch activation map from the Activities API
  const activationMap = await fetchGiftCardActivitiesMap();
  console.log(`Activities API returned activation amounts for ${activationMap.size} cards`);

  let updatedViaActivitiesApi = 0;
  const remainingCards: typeof cardsNeedingRepair = [];

  // 3. Apply Activities API amounts first
  for (const card of cardsNeedingRepair) {
    const amount = activationMap.get(card.square_id);
    if (amount !== undefined && amount > 0) {
      await db.execute(sql`
        UPDATE gift_cards
        SET activation_amount = ${amount}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${card.id}
      `);
      updatedViaActivitiesApi++;
    } else {
      remainingCards.push(card);
    }
  }

  console.log(`Activities API backfill: updated ${updatedViaActivitiesApi}, ${remainingCards.length} still need order matching`);

  // 4. For cards still unresolved, try order-matching — but ONLY for the unresolved
  //    subset so we never touch cards already fixed by the Activities API.
  let updatedViaOrderMatch = 0;
  if (remainingCards.length > 0) {
    console.log(`Falling back to order-matching for ${remainingCards.length} remaining cards...`);
    updatedViaOrderMatch = await fixActivationAmountsViaOrderMatch(remainingCards);
  }

  const stillUnresolved = remainingCards.length - updatedViaOrderMatch;
  console.log(`Backfill complete: ${updatedViaActivitiesApi} via Activities API, ${updatedViaOrderMatch} via order matching, ${stillUnresolved} unresolved`);

  return {
    totalCards: cardsNeedingRepair.length,
    updatedViaActivitiesApi,
    updatedViaOrderMatch,
    stillUnresolved
  };
}

/**
 * Internal helper: attempt order-matching activation amounts for a specific
 * subset of gift cards.  Only processes the provided list — never touches
 * cards outside it — so it cannot overwrite data from the Activities API.
 */
async function fixActivationAmountsViaOrderMatch(
  cards: Array<{ id: number; square_id: string; gan: string | null; activation_amount: number | null }>
): Promise<number> {
  if (cards.length === 0) return 0;

  // Fetch orders from Square (2-year window)
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const squareOrders = await fetchOrders(twoYearsAgo);
  console.log(`Order-match fallback: fetched ${squareOrders.length} Square orders`);

  // Also fetch full DB records for the remaining cards (need createdAt for temporal match)
  const cardIds = cards.map(c => c.id);
  const dbCardsResult = await db.execute(sql`
    SELECT id, square_id, gan, created_at, activation_amount, activation_order_id, activation_square_order_id
    FROM gift_cards
    WHERE id = ANY(${cardIds})
  `);
  const dbCards = dbCardsResult.rows as Array<{
    id: number;
    square_id: string;
    gan: string | null;
    created_at: Date;
    activation_amount: number | null;
    activation_order_id: number | null;
    activation_square_order_id: string | null;
  }>;

  let updated = 0;

  for (const giftCard of dbCards) {
    try {
      // a. Try direct Square Order ID match
      if (giftCard.activation_square_order_id) {
        const match = squareOrders.find(o => o.id === giftCard.activation_square_order_id);
        if (match) {
          const orderAmount = extractGiftCardAmountFromOrder(match, giftCard.gan || undefined);
          if (orderAmount > 0) {
            const orderFromDb = await getOrCreateOrderInDb(match);
            await updateGiftCardActivation(giftCard.id, orderAmount, orderFromDb.id, match.id);
            updated++;
            continue;
          }
        }
      }

      // b. GAN match in order line items
      if (giftCard.gan) {
        const ganMatch = squareOrders.find(order =>
          order.lineItems?.some((item: any) =>
            item.note?.includes(giftCard.gan) ||
            item.variationName?.includes(giftCard.gan) ||
            item.name?.includes(giftCard.gan)
          )
        );
        if (ganMatch) {
          const orderAmount = extractGiftCardAmountFromOrder(ganMatch, giftCard.gan);
          if (orderAmount > 0) {
            const orderFromDb = await getOrCreateOrderInDb(ganMatch);
            await updateGiftCardActivation(giftCard.id, orderAmount, orderFromDb.id, ganMatch.id);
            updated++;
            continue;
          }
        }
      }

      // c. Temporal match (within 15 minutes) limited to gift-card line items
      const cardTime = new Date(giftCard.created_at).getTime();
      const nearbyOrders = squareOrders.filter(o => {
        const diff = Math.abs(new Date(o.createdAt).getTime() - cardTime);
        return diff < 15 * 60 * 1000;
      }).filter(o =>
        o.lineItems?.some((item: any) =>
          item.name?.toLowerCase().includes('gift') ||
          item.catalogObjectId?.toLowerCase().includes('gift')
        )
      );

      if (nearbyOrders.length > 0) {
        nearbyOrders.sort((a, b) =>
          Math.abs(new Date(a.createdAt).getTime() - cardTime) -
          Math.abs(new Date(b.createdAt).getTime() - cardTime)
        );
        const best = nearbyOrders[0];
        const orderAmount = extractGiftCardAmountFromOrder(best, giftCard.gan || undefined);
        if (orderAmount > 0) {
          const orderFromDb = await getOrCreateOrderInDb(best);
          await updateGiftCardActivation(giftCard.id, orderAmount, orderFromDb.id, best.id);
          updated++;
        }
      }
    } catch (err) {
      console.error(`Order-match fallback error for card ${giftCard.id}:`, err);
    }
  }

  return updated;
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
export async function fixNewGiftCardActivationAmount(giftCardId: number): Promise<{
  id: number;
  updated: boolean;
  activationAmount?: number;
  orderId?: number;
  squareOrderId?: string;
  source: string;
  error?: string;
}> {
  console.log(`Fixing activation amount for new gift card ${giftCardId}`);
  
  try {
    // 1. Get the gift card from database
    const giftCardResult = await db.execute(sql`
      SELECT id, gan, activation_amount, activation_order_id, activation_square_order_id, created_at
      FROM gift_cards
      WHERE id = ${giftCardId}
    `);
    
    if (!giftCardResult.rows || giftCardResult.rows.length === 0) {
      return {
        id: giftCardId,
        updated: false,
        source: 'New card creation flow',
        error: 'Gift card not found'
      };
    }
    
    const giftCard = giftCardResult.rows[0];
    
    // Check if already has activation amount and order link
    const activationAmount = giftCard.activation_amount ? Number(giftCard.activation_amount) : 0;
    const activationOrderId = giftCard.activation_order_id ? Number(giftCard.activation_order_id) : null;
    const activationSquareOrderId = giftCard.activation_square_order_id ? String(giftCard.activation_square_order_id) : null;
    
    if (
      activationAmount > 0 && 
      activationOrderId !== null
    ) {
      return {
        id: giftCardId,
        updated: false,
        activationAmount: activationAmount,
        orderId: activationOrderId,
        squareOrderId: activationSquareOrderId ?? undefined,
        source: 'Already has activation data'
      };
    }
    
    // 2. Fetch recent orders from Square API
    const { fetchOrders } = await import('../squareClient');
    
    // Get orders within last 24 hours
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    
    const squareOrders = await fetchOrders(oneDayAgo);
    console.log(`Fetched ${squareOrders.length} recent orders from Square API`);
    
    // 3. Find orders with matching GAN or close timestamp
    const ganRaw = giftCard.gan;
    const gan = ganRaw ? String(ganRaw) : undefined;
    
    // Safely parse created_at as a Date
    let createdAt: Date;
    try {
      // Handle different possible formats of created_at
      if (giftCard.created_at) {
        createdAt = new Date(String(giftCard.created_at));
      } else {
        // Fallback to current time minus 1 hour if no timestamp available
        createdAt = new Date();
        createdAt.setHours(createdAt.getHours() - 1);
        console.log(`No created_at timestamp found, using fallback: ${createdAt.toISOString()}`);
      }
    } catch (error) {
      console.error(`Error parsing created_at timestamp: ${error}`);
      createdAt = new Date();
      createdAt.setHours(createdAt.getHours() - 1);
    }
    
    // 3a. Try GAN matching first
    if (gan) {
      console.log(`Searching for orders with GAN ${gan}`);
      const orderWithGan = squareOrders.find(order => {
        // Check if this order contains a line item with this gift card's GAN
        return order.lineItems?.some((item: any) => {
          return item.note?.includes(gan) || 
                 item.variationName?.includes(gan) ||
                 item.name?.includes(gan);
        });
      });
      
      if (orderWithGan) {
        console.log(`Found order with matching GAN: ${orderWithGan.id}`);
        const orderAmount = extractGiftCardAmountFromOrder(orderWithGan, gan);
        
        if (orderAmount > 0) {
          // Get or create order in our database
          const orderFromDb = await getOrCreateOrderInDb(orderWithGan);
          
          // Update gift card with accurate amount and order link
          await updateGiftCardActivation(
            giftCardId, 
            orderAmount, 
            orderFromDb.id,
            orderWithGan.id
          );
          
          return {
            id: giftCardId,
            updated: true,
            activationAmount: orderAmount,
            orderId: orderFromDb.id,
            squareOrderId: orderWithGan.id,
            source: 'GAN match in order line items'
          };
        }
      }
    }
    
    // 3b. Try temporal matching (order within 15 minutes of gift card creation)
    console.log(`Searching for orders within 15 minutes of gift card creation time: ${createdAt.toISOString()}`);
    const giftCardTime = createdAt.getTime();
    const ordersWithinTimeWindow = squareOrders.filter(order => {
      const orderTime = new Date(order.createdAt).getTime();
      const timeDifference = Math.abs(orderTime - giftCardTime);
      return timeDifference < 15 * 60 * 1000; // 15 minutes in milliseconds
    });
    
    // Further filter to only orders that have gift card line items
    const giftCardOrdersInTimeWindow = ordersWithinTimeWindow.filter(order => {
      return order.lineItems?.some((item: any) => 
        item.name?.toLowerCase().includes('gift') ||
        item.variationName?.toLowerCase().includes('gift') ||
        item.catalogObjectId?.toLowerCase().includes('gift')
      );
    });
    
    if (giftCardOrdersInTimeWindow.length > 0) {
      console.log(`Found ${giftCardOrdersInTimeWindow.length} gift card orders within time window`);
      
      // Sort by closest time match
      giftCardOrdersInTimeWindow.sort((a, b) => {
        const timeA = Math.abs(new Date(a.createdAt).getTime() - giftCardTime);
        const timeB = Math.abs(new Date(b.createdAt).getTime() - giftCardTime);
        return timeA - timeB;
      });
      
      // Get closest matching order
      const bestMatch = giftCardOrdersInTimeWindow[0];
      console.log(`Best time match: Square order ${bestMatch.id} created at ${bestMatch.createdAt}`);
      
      // Extract correct activation amount from closest time-matching order
      const orderAmount = extractGiftCardAmountFromOrder(bestMatch, gan || undefined);
      
      if (orderAmount > 0) {
        // Get or create order in our database
        const orderFromDb = await getOrCreateOrderInDb(bestMatch);
        
        // Update gift card with accurate amount and order link
        await updateGiftCardActivation(
          giftCardId, 
          orderAmount, 
          orderFromDb.id,
          bestMatch.id
        );
        
        return {
          id: giftCardId,
          updated: true,
          activationAmount: orderAmount,
          orderId: orderFromDb.id,
          squareOrderId: bestMatch.id,
          source: 'Temporal match (within 15 minutes)'
        };
      }
    }
    
    // If we get here, we couldn't find a match
    return {
      id: giftCardId,
      updated: false,
      source: 'New card creation flow',
      error: 'No matching order found'
    };
  } catch (error) {
    console.error(`Error fixing new gift card ${giftCardId}:`, error);
    return {
      id: giftCardId,
      updated: false,
      source: 'New card creation flow',
      error: error instanceof Error ? error.message : String(error)
    };
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
  withOrderLink: number;
  avgActivationAmount: number;
  cardsNeedingFix: number;
  orderLinkPercentage: number;
  activationAmountPercentage: number;
}> {
  console.log('Starting gift card linking status analysis...');
  
  try {
    // Use a single SQL query to get all statistics at once
    const result = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM gift_cards) AS total_cards,
        (SELECT COUNT(*) FROM gift_cards WHERE activation_amount IS NOT NULL AND activation_amount > 0) AS with_amount,
        (SELECT COUNT(*) FROM gift_cards WHERE activation_order_id IS NOT NULL) AS with_link,
        (SELECT AVG(activation_amount) FROM gift_cards WHERE activation_amount IS NOT NULL AND activation_amount > 0) AS avg_amount
    `);
    
    // Safely extract values
    const totalCards = Number(result.rows?.[0]?.total_cards || 0);
    const withAmount = Number(result.rows?.[0]?.with_amount || 0);
    const withLink = Number(result.rows?.[0]?.with_link || 0);
    const avgAmount = Number(result.rows?.[0]?.avg_amount || 0);
    
    console.log('Gift card statistics:', {
      totalCards,
      withAmount,
      withLink,
      avgAmount
    });
    
    // Calculate derived statistics
    const report = {
      totalGiftCards: totalCards,
      withActivationAmount: withAmount,
      withOrderLink: withLink,
      avgActivationAmount: avgAmount,
      cardsNeedingFix: totalCards - withAmount,
      orderLinkPercentage: totalCards > 0 ? Math.round((withLink / totalCards) * 100) : 0,
      activationAmountPercentage: totalCards > 0 ? Math.round((withAmount / totalCards) * 100) : 0
    };
    
    // Log comprehensive results
    console.log('Gift card analysis complete:', report);
    
    return report;
  } catch (error) {
    console.error('Error analyzing gift card linking status:', error);
    throw error;
  }
}

// Helper function to extract gift card amount from an order
function extractGiftCardAmountFromOrder(order: any, gan?: string): number {
  if (!order.lineItems || order.lineItems.length === 0) {
    return 0;
  }
  
  // Find gift card line items
  const giftCardItems = order.lineItems.filter((item: any) => {
    const isGiftCard = 
      item.name?.toLowerCase().includes('gift') || 
      item.catalogObjectId?.toLowerCase().includes('gift') ||
      (gan && (item.note?.includes(gan) || item.name?.includes(gan)));
    
    return isGiftCard;
  });
  
  if (giftCardItems.length === 0) {
    return 0;
  }
  
  // If we have a specific GAN to match
  if (gan) {
    // Try to find an exact match for this GAN
    const exactMatch = giftCardItems.find((item: any) => 
      item.note?.includes(gan) || item.name?.includes(gan)
    );
    
    if (exactMatch) {
      // Prefer basePriceMoney for accurate price even if discounted
      if (exactMatch.basePriceMoney?.amount) {
        return exactMatch.basePriceMoney.amount / 100; // Convert cents to dollars
      }
      
      // Fall back to totalMoney if basePriceMoney not available
      if (exactMatch.totalMoney?.amount) {
        return exactMatch.totalMoney.amount / 100; // Convert cents to dollars
      }
    }
  }
  
  // If no exact match found, use the first gift card item's amount
  const firstGiftCardItem = giftCardItems[0];
  
  // Prefer basePriceMoney for accurate price even if discounted
  if (firstGiftCardItem.basePriceMoney?.amount) {
    return firstGiftCardItem.basePriceMoney.amount / 100; // Convert cents to dollars
  }
  
  // Fall back to totalMoney if basePriceMoney not available
  if (firstGiftCardItem.totalMoney?.amount) {
    return firstGiftCardItem.totalMoney.amount / 100; // Convert cents to dollars
  }
  
  return 0;
}

// Helper function to get or create an order in our database
async function getOrCreateOrderInDb(squareOrder: SquareOrder): Promise<{ id: number }> {
  try {
    // First, try to find the existing order
    try {
      const existingOrder = await pgStorage.getOrderBySquareId(squareOrder.id);
      
      if (existingOrder) {
        console.log(`Found existing order with ID ${existingOrder.id} for Square order ${squareOrder.id}`);
        return { id: existingOrder.id };
      }
    } catch (findError) {
      console.error(`Error finding order by Square ID ${squareOrder.id}:`, findError);
      // Continue to try creation
    }
    
    // If not found, try to create it
    try {
      console.log(`Attempting to create order for Square ID ${squareOrder.id}`);
      const { convertSquareOrderToOrder } = await import('../squareClient');
      const orderData = convertSquareOrderToOrder(squareOrder);
      const newOrder = await pgStorage.createOrder(orderData);
      console.log(`Created new order with ID ${newOrder.id}`);
      return { id: newOrder.id };
    } catch (createError) {
      console.error(`Error creating order for Square ID ${squareOrder.id}:`, createError);
      
      // If creation fails, use a safe fallback approach
      console.log(`Using fallback approach to find order by Square ID ${squareOrder.id}`);
      
      try {
        // Use direct SQL query as a last resort
        const result = await db.execute(sql`
          SELECT id FROM orders 
          WHERE square_id = ${squareOrder.id}
          LIMIT 1
        `);
        
        // Safely access results
        const rows = result.rows;
        if (rows && rows.length > 0 && rows[0].id) {
          const orderId = Number(rows[0].id);
          console.log(`Found order through fallback query: ${orderId}`);
          return { id: orderId };
        }
      } catch (fallbackError) {
        console.error(`Fallback query failed:`, fallbackError);
      }
      
      // As a last resort, create a temporary placeholder order
      console.warn(`Could not find or create order for Square ID ${squareOrder.id}`);
      throw new Error(`Cannot find or create order for Square ID ${squareOrder.id}`);
    }
  } catch (error) {
    console.error(`Error in getOrCreateOrderInDb:`, error);
    throw error;
  }
}

// Helper function to update a gift card with activation details
async function updateGiftCardActivation(
  giftCardId: number,
  activationAmount: number,
  orderId: number,
  squareOrderId: string
): Promise<void> {
  try {
    // Use a prepared statement with proper parameter binding
    await db.execute(sql`
      UPDATE gift_cards
      SET 
        activation_amount = ${activationAmount},
        activation_order_id = ${orderId},
        activation_square_order_id = ${squareOrderId},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${giftCardId}
    `);
    
    console.log(`Successfully updated gift card ${giftCardId} with activation amount ${activationAmount} linked to order ${orderId}`);
  } catch (error) {
    console.error(`Error updating gift card ${giftCardId}:`, error);
    throw error;
  }
}