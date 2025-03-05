// Add BigInt serialization override at the top
if (typeof BigInt.prototype.toJSON !== 'function') {
 (BigInt.prototype as any).toJSON = function() {
   return this.toString();
 };
}

// Add testConnection method
export async function testConnection(): Promise<{ success: boolean, message: string }> {
 try {
   if (!process.env.SQUARE_ACCESS_TOKEN) {
     throw new Error('Square access token is not configured');
   }

   // Try to list a single location to test the connection
   const response = await squareClient.locationsApi.listLocations();

   if (!response.result || !response.result.locations) {
     throw new Error('Invalid response from Square API');
   }

   console.log('Square API test connection successful:', {
     locationCount: response.result.locations.length,
     locationIds: response.result.locations.map(l => l.id)
   });

   return {
     success: true,
     message: 'Successfully connected to Square API'
   };
 } catch (error) {
   console.error('Square API connection test failed:', {
     error,
     message: error instanceof Error ? error.message : 'Unknown error',
     stack: error instanceof Error ? error.stack : undefined
   });

   throw new Error(`Failed to connect to Square API: ${error instanceof Error ? error.message : 'Unknown error'}`);
 }
}

import { pgStorage } from './pgStorage';
import { Client, Environment } from 'square';
import {
  Transaction, InsertTransaction,
  GiftCard, InsertGiftCard,
  Category, TransactionStatus, syncState, InsertOrder, InsertOrderLineItem, InsertOrderModifier, InsertOrderDiscount
} from '@shared/schema';
import { toZonedTime, formatInTimeZone } from 'date-fns-tz';
import dotenv from 'dotenv';
//import { db } from './db'; // Import db directly instead of pgStorage
import { eq } from 'drizzle-orm';
import { orders } from '@shared/schema'; // Update this import too


// Define Eastern timezone constant
const EASTERN_TIMEZONE = 'America/New_York';

// Helper function for safe data processing
function processSafeSquareData(data: any): any {
  try {
    // First convert BigInts to strings
    const stringified = JSON.stringify(data, (key, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    });

    // Then parse back to ensure we have a clean object
    return JSON.parse(stringified);
  } catch (error) {
    console.error('Error processing Square data:', error);
    // Return a safe version of the data
    return {
      id: data.id || 'unknown',
      error: 'Failed to process data'
    };
  }
}

dotenv.config();

// Initialize Square client with production environment
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN || '',
  environment: Environment.Production
});

// Update the fetchOrders method to better handle order data
export async function fetchOrders(startDate?: Date, endDate?: Date): Promise<any[]> {
  try {
    const now = new Date();
    const start = startDate || new Date(now.setDate(now.getDate() - 30));
    const end = endDate || new Date();

    // Format dates for Square API
    const startTime = start.toISOString();
    const endTime = end.toISOString();

    console.log(`Fetching orders from ${startTime} to ${endTime}`);

    const searchRequest = {
      locationIds: [process.env.SQUARE_LOCATION_ID!],
      query: {
        filter: {
          dateTimeFilter: {
            createdAt: {
              startAt: startTime,
              endAt: endTime
            }
          },
          stateFilter: {
            states: ['COMPLETED', 'CANCELED']
          }
        },
        sort: {
          sortField: 'CREATED_AT',
          sortOrder: 'DESC'
        }
      },
      returnEntries: true,
      limit: 500
    };

    // Make API request to Square Orders API
    const response = await squareClient.ordersApi.searchOrders(searchRequest);
    const orders = response.result.orders || [];

    // Convert Square orders to our schema format
    const processedOrders = orders.map(order => ({
      squareId: order.id,
      status: order.state,
      totalMoney: order.totalMoney ? Number(order.totalMoney.amount) / 100 : 0,
      totalTax: order.totalTaxMoney ? Number(order.totalTaxMoney.amount) / 100 : 0,
      totalDiscount: order.totalDiscountMoney ? Number(order.totalDiscountMoney.amount) / 100 : 0,
      createdAt: new Date(order.createdAt || new Date()),
      closedAt: order.closedAt ? new Date(order.closedAt) : null,
      source: order.source?.name || 'unknown',
      squareData: processSafeSquareData(order)
    }));

    console.log(`Processed ${processedOrders.length} orders from Square API`);
    return processedOrders;
  } catch (error) {
    console.error('Error fetching orders from Square:', error);
    throw error;
  }
}

// Add a new function to convert Square order to our format
export function convertSquareOrderToOrder(squareOrder: any): InsertOrder {
  const safeOrder = processSafeSquareData(squareOrder);

  return {
    squareId: safeOrder.id,
    status: safeOrder.state,
    totalMoney: safeOrder.totalMoney ? Number(safeOrder.totalMoney.amount) / 100 : 0,
    totalTax: safeOrder.totalTaxMoney ? Number(safeOrder.totalTaxMoney.amount) / 100 : 0,
    totalDiscount: safeOrder.totalDiscountMoney ? Number(safeOrder.totalDiscountMoney.amount) / 100 : 0,
    createdAt: new Date(safeOrder.createdAt),
    closedAt: safeOrder.closedAt ? new Date(safeOrder.closedAt) : null,
    source: safeOrder.source?.name || 'unknown',
    squareData: safeOrder
  };
}

// Add a function to process line items
export function convertSquareLineItemToOrderLineItem(lineItem: any, orderId: number): InsertOrderLineItem {
  const safeLineItem = processSafeSquareData(lineItem);

  return {
    orderId,
    name: safeLineItem.name,
    quantity: safeLineItem.quantity || 1,
    basePriceMoney: safeLineItem.basePriceMoney ? Number(safeLineItem.basePriceMoney.amount) / 100 : 0,
    totalMoney: safeLineItem.totalMoney ? Number(safeLineItem.totalMoney.amount) / 100 : 0,
    squareData: safeLineItem
  };
}

// Add a function to process modifiers
export function convertSquareModifierToOrderModifier(modifier: any, lineItemId: number): InsertOrderModifier {
  const safeModifier = processSafeSquareData(modifier);

  return {
    lineItemId,
    name: safeModifier.name,
    basePriceMoney: safeModifier.basePriceMoney ? Number(safeModifier.basePriceMoney.amount) / 100 : null,
    totalPriceMoney: safeModifier.totalPriceMoney ? Number(safeModifier.totalPriceMoney.amount) / 100 : null,
    squareData: safeModifier
  };
}

// Add a function to process discounts
export function convertSquareDiscountToOrderDiscount(discount: any, orderId: number): InsertOrderDiscount {
  const safeDiscount = processSafeSquareData(discount);

  return {
    orderId,
    name: safeDiscount.name,
    type: safeDiscount.type,
    percentage: safeDiscount.percentage || null,
    amountMoney: safeDiscount.amountMoney ? Number(safeDiscount.amountMoney.amount) / 100 : null,
    appliedMoney: safeDiscount.appliedMoney ? Number(safeDiscount.appliedMoney.amount) / 100 : 0,
    scope: safeDiscount.scope || 'ORDER',
    squareData: safeDiscount
  };
}

// Add enhanced gift card redemption detection
function isGiftCardRedemption(payment: any): boolean {
  try {
    // Check for gift card payment source
    const isGiftCard = (
      (payment.sourceType && payment.sourceType === 'GIFT_CARD') ||
      (payment.cardDetails && payment.cardDetails.entryMethod === 'GIFT_CARD')
    );

    if (isGiftCard) {
      // Extract the gift card ID from the payment source
      let sourceId = null;
      if (payment.sourceId) {
        sourceId = payment.sourceId;
      } else if (payment.cardDetails?.card?.id) {
        sourceId = payment.cardDetails.card.id;
      }

      console.log(`Found gift card redemption payment:`, {
        paymentId: payment.id,
        sourceType: payment.sourceType,
        cardDetails: payment.cardDetails,
        sourceId: sourceId,
        amount: payment.amountMoney ? Number(payment.amountMoney.amount) / 100 : 0
      });

      // Add additional information to the payment object
      payment.isGiftCardRedemption = true;
      payment.sourceId = sourceId;
      payment.redemptionAmount = payment.amountMoney
        ? Number(payment.amountMoney.amount) / 100
        : 0;
    }

    return isGiftCard;
  } catch (error) {
    console.error('Error checking gift card redemption:', error);
    return false;
  }
}

// Update the fetchPayments method with better pagination control and timing logs
export async function fetchPayments(startDate?: Date, endDate?: Date): Promise<any[]> {
  try {
    const now = new Date();
    const start = startDate || new Date(now.setDate(now.getDate() - 30));
    const end = endDate || new Date();

    // Format dates for Square API
    const beginTime = start.toISOString();
    const endTime = end.toISOString();

    console.log(`Starting payment fetch from Square API:`, {
      startDate: beginTime,
      endDate: endTime,
      locationId: process.env.SQUARE_LOCATION_ID
    });

    if (!process.env.SQUARE_ACCESS_TOKEN) {
      throw new Error('Square access token is not configured');
    }

    if (!process.env.SQUARE_LOCATION_ID) {
      throw new Error('Square location ID is not configured');
    }

    let allPayments: any[] = [];
    let cursor: string | undefined = undefined;
    let hasMorePages = true;
    let pageCount = 0;
    const MAX_PAGES = 10; // Temporarily reduced for testing
    const START_TIME = Date.now();
    const TIMEOUT = 5 * 60 * 1000; // 5 minute timeout

    while (hasMorePages && pageCount < MAX_PAGES) {
      pageCount++;
      const pageStartTime = Date.now();
      console.log(`Starting to fetch payments page ${pageCount}${cursor ? ' with cursor' : ''} at ${new Date(pageStartTime).toISOString()}`);

      // Check for timeout
      if (Date.now() - START_TIME > TIMEOUT) {
        throw new Error('Sync timeout reached after 5 minutes');
      }

      try {
        const response = await squareClient.paymentsApi.listPayments(
          beginTime,
          endTime,
          'DESC',
          cursor,
          process.env.SQUARE_LOCATION_ID
        );

        const pageEndTime = Date.now();
        const pageProcessingTime = pageEndTime - pageStartTime;

        console.log('Square API Response:', {
          page: pageCount,
          status: response.statusCode,
          hasMore: !!response.result.cursor,
          paymentCount: response.result.payments?.length || 0,
          processingTimeMs: pageProcessingTime
        });

        const payments = response.result.payments || [];

        if (!Array.isArray(payments)) {
          throw new Error(`Invalid response format from Square API: expected array, got ${typeof payments}`);
        }

        // Process each payment
        for (const payment of payments) {
          try {
            if (isGiftCardRedemption(payment)) {
              console.log(`Processing gift card redemption payment: ${payment.id}`);
            }
            allPayments.push(payment);
          } catch (paymentError) {
            console.error(`Error processing payment ${payment.id}:`, paymentError);
          }
        }

        cursor = response.result.cursor;
        hasMorePages = !!cursor;

        if (hasMorePages) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (pageError) {
        const errorDetail = {
          error: pageError,
          message: pageError instanceof Error ? pageError.message : 'Unknown error',
          stack: pageError instanceof Error ? pageError.stack : undefined,
          page: pageCount,
          cursor,
          timeElapsed: Date.now() - START_TIME
        };
        console.error('Error fetching payments page:', errorDetail);
        throw new Error(`Failed to fetch page ${pageCount}: ${errorDetail.message}`);
      }
    }

    const totalTime = Date.now() - START_TIME;
    if (pageCount >= MAX_PAGES) {
      console.warn(`Reached maximum page limit (${MAX_PAGES}). Some payments may be missing. Total time: ${totalTime}ms`);
    }

    console.log(`Successfully fetched ${allPayments.length} payments from Square API in ${totalTime}ms`);
    return allPayments;
  } catch (error) {
    console.error('Error in fetchPayments:', {
      error,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      totalTimeMs: Date.now() - START_TIME
    });
    throw error;
  }
}

// Update convertSquarePaymentToTransaction function
export function convertSquarePaymentToTransaction(payment: Record<string, any>): InsertTransaction {
  // Extract the amount
  const amountMoney = payment.amountMoney;
  let amount = 0;

  // Handle BigInt conversion safely
  if (amountMoney && amountMoney.amount !== undefined) {
    // Check if it's a BigInt and convert appropriately
    if (typeof amountMoney.amount === 'bigint') {
      amount = Number(amountMoney.amount) / 100;
    } else {
      // Regular number conversion
      amount = (Number(amountMoney.amount) || 0) / 100;
    }
  }

  // IMPORTANT: We need to handle gift card purchases differently than gift card payments
  // Gift card PURCHASES - When a customer BUYS a gift card (this should be categorized as a gift card sale)
  // Gift card PAYMENTS - When a customer PAYS USING a gift card (this should NOT be categorized as a gift card)

  // First check if this is a payment USING a gift card (not a gift card purchase)
  const paidWithGiftCard =
    (payment.sourceType && payment.sourceType === 'GIFT_CARD') ||
    (payment.cardDetails && payment.cardDetails.entryMethod === 'GIFT_CARD');

  let category: Category = 'retail'; // Default category

  if (paidWithGiftCard) {
    // Log gift card payment details
    console.log(`Payment USING gift card detected:`, {
      paymentId: payment.id,
      amount: amount,
      sourceId: payment.sourceId || payment.cardDetails?.card?.id
    });

    // For payments using gift cards, we want to categorize based on what was purchased
    if (payment.orderId && payment.orderName) {
      category = mapSquareCategory(payment.orderName);
    } else if (payment.note) {
      category = mapSquareCategory(payment.note);
    }
  } else {
    // If not paid with gift card, check if it's a gift card purchase
    let isGiftCardPurchase = false;

    // Check order data for gift card items
    if (payment.orderId && payment.orderData) {
      try {
        const orderData = typeof payment.orderData === 'string'
          ? JSON.parse(payment.orderData)
          : payment.orderData;

        if (orderData.lineItems && Array.isArray(orderData.lineItems)) {
          const giftCardItems = orderData.lineItems.filter((item: any) =>
            item.itemType === 'GIFT_CARD' ||
            (item.name && item.name.toLowerCase().includes('gift card'))
          );

          if (giftCardItems.length > 0) {
            isGiftCardPurchase = true;
            console.log(`Found gift card purchase in order ${payment.orderId}`);
          }
        }
      } catch (error) {
        console.error(`Error checking order data for gift cards:`, error);
      }
    }

    // Set category based on our detection
    if (isGiftCardPurchase) {
      category = 'giftCard';
    } else {
      category = payment.orderName ? mapSquareCategory(payment.orderName) : 'retail';
    }
  }

  // Parse and convert the timestamp
  let timestamp: Date = new Date(payment.createdAt);
  if (isNaN(timestamp.getTime())) {
    console.warn(`Invalid timestamp for payment ${payment.id}, using current date`);
    timestamp = new Date();
  }

  // Convert payment data to handle BigInt values
  const cleanedPaymentData = processSafeSquareData(payment);

  // Map to our transaction model, preserving gift card redemption flags
  const transaction: InsertTransaction = {
    squareId: payment.id,
    amount,
    categoryId: category,
    status: mapSquareStatus(payment.status),
    timestamp,
    squareData: {
      ...cleanedPaymentData,
      isGiftCardRedemption: payment.isGiftCardRedemption || false,
      redemptionAmount: payment.redemptionAmount || 0,
      sourceId: payment.sourceId || payment.cardDetails?.card?.id
    }
  };

  // Log transaction creation for gift card payments
  if (payment.isGiftCardRedemption) {
    console.log(`Created transaction from gift card payment:`, {
      squareId: transaction.squareId,
      amount: transaction.amount,
      isGiftCardRedemption: (transaction.squareData as any)?.isGiftCardRedemption,
      redemptionAmount: (transaction.squareData as any)?.redemptionAmount,
      sourceId: (transaction.squareData as any)?.sourceId
    });
  }

  return transaction;
}

// Convert Square gift card to our GiftCard model
export function convertSquareGiftCardToGiftCard(giftCard: Record<string, any>): InsertGiftCard {
  // Convert the input to safe format first
  const safeGiftCard = processSafeSquareData(giftCard);

  // Parse and convert the purchase date from UTC to Eastern Time for proper business day alignment
  let purchaseDate: Date;
  try {
    // Parse the Square API timestamp string as UTC (Square provides timestamps in UTC)
    const utcPurchaseDate = new Date(safeGiftCard.created_at);

    // Validate the date
    if (isNaN(utcPurchaseDate.getTime())) {
      // If invalid, use current date
      console.warn(`Invalid purchase date for gift card ${safeGiftCard.id}, using current date instead`);
      purchaseDate = new Date();
    } else {
      // Convert the UTC timestamp to a date in Eastern timezone
      // This preserves the exact same moment in time but represents it in Eastern timezone
      // This ensures that midnight-to-midnight in Eastern time is properly preserved
      purchaseDate = toZonedTime(utcPurchaseDate, EASTERN_TIMEZONE);

      // Log the timestamp conversion for debugging
      console.log(`Gift card ${safeGiftCard.id} purchase date conversion:`, {
        original: safeGiftCard.created_at,
        utc: utcPurchaseDate.toISOString(),
        eastern: formatInTimeZone(purchaseDate, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
      });
    }
  } catch (error) {
    console.warn(`Error processing purchase date for gift card ${safeGiftCard.id}, using current date instead:`, error);
    purchaseDate = new Date();
  }

  // Extract amount from balanceMoney
  let amount = 0;
  if (safeGiftCard.balanceMoney?.amount) {
    amount = Number(safeGiftCard.balanceMoney.amount) / 100;
  } else if (safeGiftCard.balance_money?.amount) {
    amount = Number(safeGiftCard.balance_money.amount) / 100;
  }

  console.log(`Processing gift card ${safeGiftCard.id} with amount: $${amount}`);

  const card: InsertGiftCard = {
    squareId: safeGiftCard.id,
    amount: amount,
    redeemedAmount: 0, // May need to calculate this separately
    isActive: safeGiftCard.state === 'ACTIVE',
    purchaseDate,
    squareData: safeGiftCard
  };

  return card;
}

// Fetch gift cards from Square API with enhanced error handling
export async function fetchGiftCards(): Promise<any[]> {
  try {
    let allGiftCards: any[] = [];
    let cursor: string | undefined = undefined;
    let hasMorePages = true;
    let pageCount = 0;

    while (hasMorePages) {
      pageCount++;
      console.log(`Fetching gift cards page ${pageCount}${cursor ? ' with cursor' : ''}`);

      try {
        const response = await squareClient.giftCardsApi.listGiftCards(
          undefined,  // type
          undefined,  // state
          100,        // limit
          cursor,     // cursor
          undefined   // customerId
        );

        if (!response.result.giftCards) {
          console.log('No gift cards found in response');
          break;
        }

        // Process each gift card to ensure it's safe for database storage
        const safeGiftCards = response.result.giftCards.map(card => {
          try {
            const safeCard = processSafeSquareData(card);

            // Log amount information for debugging
            if (safeCard.balanceMoney?.amount) {
              console.log(`Card ${safeCard.id} balance: $${Number(safeCard.balanceMoney.amount) / 100}`);
            } else if (safeCard.balance_money?.amount) {
              console.log(`Card ${safeCard.id} balance: $${Number(safeCard.balance_money.amount) / 100}`);
            }

            return safeCard;
          } catch (error) {
            console.error(`Error processing gift card:`, error);
            return null;
          }
        }).filter(card => card !== null); // Remove any cards that failed processing

        allGiftCards = [...allGiftCards, ...safeGiftCards];
        console.log(`Processed ${safeGiftCards.length} gift cards on page ${pageCount}. Total so far: ${allGiftCards.length}`);

        cursor = response.result.cursor;
        hasMorePages = !!cursor;

        if (hasMorePages) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error('Error fetching gift cards page:', error);
        hasMorePages = false;
      }
    }

    console.log(`Completed fetching ${allGiftCards.length} total gift cards`);
    return allGiftCards;
  } catch (error) {
    console.error('Error fetching gift cards:', error);
    throw error;
  }
}

// Map Square payment status to our TransactionStatus
function mapSquareStatus(status: string): TransactionStatus {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'CANCELED':
    case 'VOIDED':
      return 'refunded';
    default:
      return 'pending';
  }
}

// Map Square category to our Category
function mapSquareCategory(itemName: string): Category {
  const lowerItemName = itemName.toLowerCase();

  if (lowerItemName.includes('food') || lowerItemName.includes('meal') || lowerItemName.includes('burger')) {
    return 'food';
  } else if (lowerItemName.includes('drink') || lowerItemName.includes('soda') || lowerItemName.includes('beverage')) {
    return 'drinks';
  } else if (lowerItemName.includes('gift') && lowerItemName.includes('card')) {
    return 'giftCard';
  } else if (lowerItemName.includes('service') || lowerItemName.includes('repair')) {
    return 'services';
  } else {
    return 'retail';
  }
}


// Utility function to search for gift card items in the catalog
export async function searchCatalogForGiftCards(): Promise<any[]> {
  try {
    // Call Square Catalog API to find gift card items
    const response = await squareClient.catalogApi.listCatalog(
      undefined, // cursor
      "ITEM" // object_types - specifically looking for catalog items
    );

    // Filter to find gift card items
    const giftCardItems = (response.result.objects || []).filter((item: any) => {
      if (item.type !== 'ITEM') return false;

      // Check item data
      const itemData = item.itemData;
      if (!itemData) return false;

      // Look for gift card indicators in name or description
      const name = (itemData.name || '').toLowerCase();
      const description = (itemData.description || '').toLowerCase();

      return (
        name.includes('gift card') ||
        name.includes('gift certificate') ||
        description.includes('gift card') ||
        description.includes('gift certificate')
      );
    });

    console.log(`Found ${giftCardItems.length} gift card items in catalog`);
    return giftCardItems;
  } catch (error) {
    console.error('Error searching catalog for gift cards:', error);
    return [];
  }
}

// Add enhanced error handling and logging for Order processing
export async function processSquareOrder(order: any, db: any): Promise<void> {
  try {
    console.log(`Processing Square order: ${order.id}`);

    // Convert order to our format
    const insertOrder = convertSquareOrderToOrder(order);
    console.log(`Converted order ${order.id} to internal format`);

    // Create order in database
    const savedOrder = await db.createOrder(insertOrder);
    console.log(`Saved order ${order.id} to database with internal ID ${savedOrder.id}`);

    // Process line items
    if (order.lineItems && Array.isArray(order.lineItems)) {
      for (const lineItem of order.lineItems) {
        try {
          const insertLineItem = convertSquareLineItemToOrderLineItem(lineItem, savedOrder.id);
          const savedLineItem = await db.createOrderItem(insertLineItem);
          console.log(`Saved line item for order ${order.id}: ${lineItem.name}`);

          // Process modifiers for this line item
          if (lineItem.modifiers && Array.isArray(lineItem.modifiers)) {
            for (const modifier of lineItem.modifiers) {
              try {
                const insertModifier = convertSquareModifierToOrderModifier(modifier, savedLineItem.id);
                await db.createOrderModifier(insertModifier);
                console.log(`Saved modifier for line item ${lineItem.name}: ${modifier.name}`);
              } catch (modifierError) {
                console.error(`Error processing modifier for line item ${lineItem.name}:`, modifierError);
                // Continue processing other modifiers
              }
            }
          }
        } catch (lineItemError) {
          console.error(`Error processing line item for order ${order.id}:`, lineItemError);
          // Continue processing other line items
        }
      }
    }

    // Process discounts
    if (order.discounts && Array.isArray(order.discounts)) {
      for (const discount of order.discounts) {
        try {
          const insertDiscount = convertSquareDiscountToOrderDiscount(discount, savedOrder.id);
          await db.createOrderDiscount(insertDiscount);
          console.log(`Saved discount for order ${order.id}: ${discount.name}`);
        } catch (discountError) {
          console.error(`Error processing discount for order ${order.id}:`, discountError);
          // Continue processing other discounts
        }
      }
    }

    // Link order to transaction if available
    if (order.tenders && Array.isArray(order.tenders)) {
      for (const tender of order.tenders) {
        if (tender.paymentId) {
          try {
            const transaction = await db.getTransactionBySquareId(tender.paymentId);
            if (transaction) {
              await db.update(orders)
                .set({ transactionId: transaction.id })
                .where(eq(orders.id, savedOrder.id))
                .execute();
              console.log(`Linked order ${order.id} to transaction ${tender.paymentId}`);
            }
          } catch (linkError) {
            console.error(`Error linking order ${order.id} to transaction ${tender.paymentId}:`, linkError);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error processing Square order:', error);
    throw error;
  }
}

// Update syncOrders function to properly use pgStorage
export async function syncOrders(startDate?: Date, endDate?: Date): Promise<void> {
  try {
    // Create or get orders sync state
    let syncState = await pgStorage.getSyncState('orders');
    if (!syncState) {
      syncState = await pgStorage.createSyncState({
        syncType: 'orders',
        lastSyncedAt: new Date(),
        currentPage: 1,
        totalPages: 0,
        processedCount: 0,
        totalCount: 0,
        cursor: '',
        isComplete: false,
        status: 'pending',
        errorMessage: null,
        lastCheckpoint: null
      });
    }

    console.log(`Starting orders sync from ${startDate?.toISOString() || '30 days ago'} to ${endDate?.toISOString() || 'now'}`);

    // Fetch orders from Square
    const orders = await fetchOrders(startDate, endDate);
    console.log(`Fetched ${orders.length} orders from Square`);

    // Process each order
    let successCount = 0;
    let errorCount = 0;

    for (const order of orders) {
      try {
        // Convert order to our format
        const insertOrder = convertSquareOrderToOrder(order);

        // Create order in database
        const savedOrder = await pgStorage.createOrder(insertOrder);
        console.log(`Saved order ${order.id} to database with internal ID ${savedOrder.id}`);

        // Process line items
        if (order.lineItems && Array.isArray(order.lineItems)) {
          for (const lineItem of order.lineItems) {
            try {
              const insertLineItem = convertSquareLineItemToOrderLineItem(lineItem, savedOrder.id);
              const savedLineItem = await pgStorage.createOrderItem(insertLineItem);
              console.log(`Saved line item for order ${order.id}: ${lineItem.name}`);

              // Process modifiers for this line item
              if (lineItem.modifiers && Array.isArray(lineItem.modifiers)) {
                for (const modifier of lineItem.modifiers) {
                  try {
                    const insertModifier = convertSquareModifierToOrderModifier(modifier, savedLineItem.id);
                    await pgStorage.createOrderModifier(insertModifier);
                  } catch (modifierError) {
                    console.error(`Error processing modifier for line item ${lineItem.name}:`, modifierError);
                  }
                }
              }
            } catch (lineItemError) {
              console.error(`Error processing line item for order ${order.id}:`, lineItemError);
            }
          }
        }

        // Process discounts
        if (order.discounts && Array.isArray(order.discounts)) {
          for (const discount of order.discounts) {
            try {
              const insertDiscount = convertSquareDiscountToOrderDiscount(discount, savedOrder.id);
              await pgStorage.createOrderDiscount(insertDiscount);
            } catch (discountError) {
              console.error(`Error processing discount for order ${order.id}:`, discountError);
            }
          }
        }

        successCount++;

        // Update sync progress
        await pgStorage.updateSyncState(syncState.id, {
          processedCount: successCount,
          totalCount: orders.length,
          lastSyncedAt: new Date(),
          status: 'in_progress'
        });
      } catch (error) {
        errorCount++;
        console.error(`Failed to process order ${order.id}:`, error);
      }
    }

    // Update final sync state
    await pgStorage.updateSyncState(syncState.id, {
      processedCount: successCount,
      totalCount: orders.length,
      isComplete: true,
      status: errorCount > 0 ? 'completed_with_errors' : 'completed',
      errorMessage: errorCount > 0 ? `Failed to process ${errorCount} orders` : null,
      lastSyncedAt: new Date()
    });

    console.log(`Completed orders sync. Success: ${successCount}, Errors: ${errorCount}`);
  } catch (error) {
    console.error('Error during orders sync:', error);
    throw error;
  }
}

export { squareClient };