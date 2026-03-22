// Add BigInt serialization override at the top level
// This is a safer approach that doesn't modify the prototype
(BigInt.prototype as any).toJSON = function() {
  return this.toString();
};

// Add testConnection method
export async function testConnection(): Promise<{ success: boolean, message: string }> {
 try {
   if (!process.env.SQUARE_ACCESS_TOKEN) {
     throw new Error('Square access token is not configured');
   }

   const response = await squareClient.locations.list();

   if (!response.locations) {
     throw new Error('Invalid response from Square API');
   }

   console.log('Square API test connection successful:', {
     locationCount: response.locations.length,
     locationIds: response.locations.map((l: any) => l.id)
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
import { SquareClient, SquareEnvironment } from 'square';
import {
  Transaction, InsertTransaction,
  GiftCard, InsertGiftCard,
  InsertRefund,
  Category, TransactionStatus, syncState, InsertOrder, InsertOrderLineItem, InsertOrderModifier, InsertOrderDiscount
} from '@shared/schema';
import { formatInTimeZone } from 'date-fns-tz';
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

const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN || '',
  environment: SquareEnvironment.Production
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
    
    if (!process.env.SQUARE_ACCESS_TOKEN) {
      console.error('Square access token is not configured');
      throw new Error('Square access token is not configured');
    }

    if (!process.env.SQUARE_LOCATION_ID) {
      console.error('Square location ID is not configured');
      throw new Error('Square location ID is not configured');
    }
    
    console.log(`Using Square location ID: ${process.env.SQUARE_LOCATION_ID}`);

    // Create a search request for orders
    const searchRequest = {
      locationIds: [process.env.SQUARE_LOCATION_ID],
      query: {
        filter: {
          dateTimeFilter: {
            createdAt: {
              startAt: startTime,
              endAt: endTime
            }
          },
          stateFilter: {
            states: ['COMPLETED', 'OPEN']  // Include both COMPLETED and OPEN orders
          }
        },
        sort: {
          sortField: 'CREATED_AT',
          sortOrder: 'DESC'
        }
      },
      // Increase limit to fetch more orders at once
      limit: 200
    };
    
    console.log('Orders search request:', JSON.stringify(searchRequest, null, 2));

    // Make API request to Square Orders API with cursor-based pagination
    try {
      const allOrders: any[] = [];
      let cursor: string | undefined = undefined;
      let page = 0;

      do {
        page++;
        const request: any = { ...searchRequest };
        if (cursor) request.cursor = cursor;

        const response = await squareClient.orders.search(request);

        if (!response.orders || !Array.isArray(response.orders)) {
          if (page === 1) console.warn('No orders found in Square API response');
          break;
        }

        const pageOrders = response.orders.filter((o: any) => o && o.id);
        allOrders.push(...pageOrders);
        cursor = (response as any).cursor ?? undefined;

        console.log(`Orders page ${page}: ${pageOrders.length} orders (cursor: ${cursor ? 'yes' : 'none'})`);
      } while (cursor);

      console.log(`Found ${allOrders.length} total orders from Square API (${page} page${page !== 1 ? 's' : ''})`);

      if (allOrders.length > 0) {
        const firstOrder = allOrders[0];
        console.log('Sample order data structure:', JSON.stringify({
          id: firstOrder.id || 'missing',
          state: firstOrder.state || 'missing',
          createdAt: firstOrder.createdAt || 'missing',
          lineItemCount: firstOrder.lineItems?.length || 0
        }, null, 2));
      }

      return allOrders;
    } catch (apiError) {
      console.error('Square Orders API error:', {
        error: apiError,
        message: apiError instanceof Error ? apiError.message : 'Unknown error',
        stack: apiError instanceof Error ? apiError.stack : undefined
      });
      
      throw new Error(`Square Orders API error: ${apiError instanceof Error ? apiError.message : 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Error in fetchOrders:', {
      error,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}

// Add a new function to convert Square order to our format
export function convertSquareOrderToOrder(squareOrder: any): InsertOrder {
  try {
    // Create a safe copy of the order data
    const safeOrder = processSafeSquareData(squareOrder);
    
    // Enhanced validation with detailed logging
    if (!safeOrder || typeof safeOrder !== 'object') {
      console.error("Invalid Square order data: not an object", {
        type: typeof squareOrder,
        value: squareOrder
      });
      throw new Error("Invalid Square order data: not an object");
    }
    
    // Ensure all required fields are present
    if (!safeOrder.id) {
      console.error("Square order missing required field: id", {
        orderData: JSON.stringify(safeOrder).substring(0, 500) // Log a portion of the data for debugging
      });
      throw new Error("Invalid Square order data: missing id");
    }
    
    // Check for gift card items in the order with enhanced detection
    let hasGiftCardItems = false;
    let giftCardTotal = 0;
    
    if (safeOrder.lineItems && Array.isArray(safeOrder.lineItems)) {
      // More comprehensive detection with multiple patterns
      const giftCardItems = safeOrder.lineItems.filter((item: any) => {
        // Check multiple patterns that might indicate gift card
        const isGiftCard = 
          // Direct type check  
          item.itemType === 'GIFT_CARD' || 
          
          // Name-based checks (with defensive coding)
          (item.name && typeof item.name === 'string' && (
            item.name.toLowerCase().includes('gift') ||
            item.name.toLowerCase().includes('card') ||
            item.name.toLowerCase().includes('deposit')
          )) ||
          
          // Special case for items that are marked as gift cards in metadata
          (item.metadata && item.metadata.isGiftCard === 'true') ||
          
          // Check catalog object type if available
          (item.catalogObjectType === 'GIFT_CARD');
        
        // Mark the item as a gift card in its data for easy detection later
        if (isGiftCard && item) {
          item.isGiftCard = true;
          
          // Calculate the gift card amount
          if (item.totalMoney && item.totalMoney.amount) {
            item.giftCardAmount = Number(item.totalMoney.amount) / 100;
            giftCardTotal += item.giftCardAmount;
          }
        }
        
        return isGiftCard;
      });
      
      if (giftCardItems.length > 0) {
        console.log(`Found gift card purchase in order ${safeOrder.id}`);
        hasGiftCardItems = true;
        
        // Log the gift card items for verification
        giftCardItems.forEach((item: any, index: number) => {
          console.log(`Gift card item ${index + 1}:`, {
            name: item.name,
            quantity: item.quantity,
            totalMoney: item.totalMoney ? Number(item.totalMoney.amount) / 100 : 0,
            giftCardAmount: item.giftCardAmount || 0
          });
        });
      }
    }
    
    // Create order object with safe defaults for all fields
    return {
      squareId: safeOrder.id,
      status: safeOrder.state || "COMPLETED", // Default to COMPLETED if no state provided
      totalMoney: safeOrder.totalMoney ? Number(safeOrder.totalMoney.amount) / 100 : 0,
      totalTax: safeOrder.totalTaxMoney ? Number(safeOrder.totalTaxMoney.amount) / 100 : 0,
      totalDiscount: safeOrder.totalDiscountMoney ? Number(safeOrder.totalDiscountMoney.amount) / 100 : 0,
      createdAt: safeOrder.createdAt ? new Date(safeOrder.createdAt) : new Date(), // Default to current date if missing
      closedAt: safeOrder.closedAt ? new Date(safeOrder.closedAt) : null,
      source: safeOrder.source?.name || 'unknown',
      // Add a marker for gift card purchases in the squareData
      squareData: {
        ...safeOrder,
        hasGiftCardItems, // Flag to indicate this order contains gift card items
        giftCardTotal, // Total amount of gift cards in this order
        isGiftCardPurchase: hasGiftCardItems // Alternative flag name for consistency
      }
    };
  } catch (error) {
    console.error("Error in convertSquareOrderToOrder:", error);
    throw error;
  }
}

/**
 * Fetch specific orders from Square by their IDs using the batch retrieve API.
 * Used to sync orders that are referenced by gift cards but not yet in our DB.
 *
 * @param orderIds  Square order IDs to retrieve (max 100 per call)
 * @returns         Array of InsertOrder ready for DB insertion
 */
export async function fetchOrdersByIds(orderIds: string[]): Promise<InsertOrder[]> {
  if (orderIds.length === 0) return [];

  const results: InsertOrder[] = [];
  const BATCH_SIZE = 100;

  for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
    const batch = orderIds.slice(i, i + BATCH_SIZE);
    try {
      const response = await squareClient.orders.batchGet({
        locationId: process.env.SQUARE_LOCATION_ID!,
        orderIds: batch,
      });
      const squareOrders = (response as any).orders ?? [];
      for (const squareOrder of squareOrders) {
        try {
          results.push(convertSquareOrderToOrder(squareOrder));
        } catch {
          // skip malformed orders
        }
      }
    } catch (error) {
      console.error(`[fetchOrdersByIds] Error fetching batch starting at ${i}:`, error);
    }
  }

  return results;
}

// Add a function to process line items
export function convertSquareLineItemToOrderLineItem(lineItem: any, orderId: number): InsertOrderLineItem {
  const safeLineItem = processSafeSquareData(lineItem);

  // Special handling for Tripleseat or other payments that might not have a name
  let itemName = safeLineItem.name;
  if (!itemName) {
    // Check if it's a Tripleseat payment
    if (safeLineItem.note && safeLineItem.note.includes('Tripleseat')) {
      itemName = 'Tripleseat Payment';
    } else {
      // Fallback name for any unnamed item
      itemName = 'Unnamed Item';
    }
    console.log(`Found line item with missing name, using fallback: ${itemName}`, safeLineItem);
  }

  // Detect if this is a gift card item
  const isGiftCard = 
    safeLineItem.itemType === 'GIFT_CARD' || 
    (itemName && typeof itemName === 'string' && 
     (itemName.toLowerCase().includes('gift card') || 
      itemName.toLowerCase().includes('giftcard')));
  
  if (isGiftCard) {
    // Use basePriceMoney instead of totalMoney for gift card activation amount
    // This ensures we get the correct amount even when the gift card was discounted or comped
    const basePrice = safeLineItem.basePriceMoney ? Number(safeLineItem.basePriceMoney.amount) / 100 : 0;
    const finalPrice = safeLineItem.totalMoney ? Number(safeLineItem.totalMoney.amount) / 100 : 0;
    
    console.log(`Found gift card line item: ${itemName} with base price: $${basePrice}, final price: $${finalPrice}`);
    
    // Add gift card metadata to the squareData
    safeLineItem.isGiftCard = true;
    // Prioritize using the base price for gift card value (before discounts)
    safeLineItem.giftCardAmount = basePrice || finalPrice;
  }

  // Determine the category for the item
  let category = mapSquareCategory(itemName, safeLineItem.itemType || '');
  
  return {
    orderId,
    name: itemName,
    quantity: safeLineItem.quantity || 1,
    basePriceMoney: safeLineItem.basePriceMoney ? Number(safeLineItem.basePriceMoney.amount) / 100 : 0,
    totalMoney: safeLineItem.totalMoney ? Number(safeLineItem.totalMoney.amount) / 100 : 0,
    category: category,
    productId: safeLineItem.catalogObjectId || null,
    isGiftCard: isGiftCard,
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
export function isGiftCardRedemption(payment: any): boolean {
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

export interface FetchPaymentsResult {
  payments: any[];
  hitPageCap: boolean;
}

export async function fetchPayments(startDate?: Date, endDate?: Date): Promise<any[]>;
export async function fetchPayments(startDate: Date, endDate: Date, opts: { returnMeta: true }): Promise<FetchPaymentsResult>;
export async function fetchPayments(startDate?: Date, endDate?: Date, opts?: { returnMeta: true }): Promise<any[] | FetchPaymentsResult> {
  const startTime = Date.now(); // Initialize this at the very top to avoid reference errors
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
    let hasMorePages = true;
    let pageCount = 0;
    let paymentsPage: any = null;
    const MAX_PAGES = 50; // Allow up to 50 pages (5,000 payments) per sync
    const TIMEOUT = 5 * 60 * 1000; // 5 minute timeout

    while (hasMorePages && pageCount < MAX_PAGES) {
      pageCount++;
      const pageStartTime = Date.now();
      console.log(`Starting to fetch payments page ${pageCount}${cursor ? ' with cursor' : ''} at ${new Date(pageStartTime).toISOString()}`);

      // Check for timeout
      if (Date.now() - startTime > TIMEOUT) {
        throw new Error('Sync timeout reached after 5 minutes');
      }

      try {
        if (pageCount === 1) {
          paymentsPage = await squareClient.payments.list({
            beginTime,
            endTime,
            sortOrder: 'DESC',
            locationId: process.env.SQUARE_LOCATION_ID
          });
        } else {
          paymentsPage = await paymentsPage!.getNextPage();
        }

        const pageEndTime = Date.now();
        const pageProcessingTime = pageEndTime - pageStartTime;

        console.log('Square API Response:', {
          page: pageCount,
          hasMore: paymentsPage.hasNextPage(),
          paymentCount: paymentsPage.data?.length || 0,
          processingTimeMs: pageProcessingTime
        });

        const payments = paymentsPage.data || [];

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

        hasMorePages = paymentsPage.hasNextPage();

        if (hasMorePages) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (pageError) {
        const errorDetail = {
          error: pageError,
          message: pageError instanceof Error ? pageError.message : 'Unknown error',
          stack: pageError instanceof Error ? pageError.stack : undefined,
          page: pageCount,
          timeElapsed: Date.now() - startTime
        };
        console.error('Error fetching payments page:', errorDetail);
        throw new Error(`Failed to fetch page ${pageCount}: ${errorDetail.message}`);
      }
    }

    const totalTime = Date.now() - startTime;
    const hitPageCap = pageCount >= MAX_PAGES;
    if (hitPageCap) {
      console.warn(`Reached maximum page limit (${MAX_PAGES}). Some payments may be missing. Total time: ${totalTime}ms`);
    }

    console.log(`Successfully fetched ${allPayments.length} payments from Square API in ${totalTime}ms`);
    if (opts?.returnMeta) {
      return { payments: allPayments, hitPageCap };
    }
    return allPayments;
  } catch (error) {
    console.error('Error in fetchPayments:', {
      error,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      totalTimeMs: Date.now() - startTime
    });
    throw error;
  }
}

// Update convertSquarePaymentToTransaction function
export function convertSquarePaymentToTransaction(payment: Record<string, any>): InsertTransaction {
  // Use totalMoney (amountMoney + tipMoney) to match Square's "Total payments collected".
  // For cash/external/gift-card payments with no tip, totalMoney === amountMoney.
  // Fall back to amountMoney if totalMoney is absent (e.g. very old API responses).
  const moneySource = payment.totalMoney ?? payment.amountMoney;
  let amount = 0;

  // Handle BigInt conversion safely
  if (moneySource && moneySource.amount !== undefined) {
    // Check if it's a BigInt and convert appropriately
    if (typeof moneySource.amount === 'bigint') {
      amount = Number(moneySource.amount) / 100;
    } else {
      // Regular number conversion
      amount = (Number(moneySource.amount) || 0) / 100;
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
// Pass activationAmountOverride (in dollars) when you already have the activation amount
// from the Gift Card Activities API – this is preferred over the balance-based fallback.
export function convertSquareGiftCardToGiftCard(giftCard: Record<string, any>, activationAmountOverride?: number): InsertGiftCard {
  // Convert the input to safe format first
  const safeGiftCard = processSafeSquareData(giftCard);

  // Parse and convert the purchase date from UTC to Eastern Time for proper business day alignment
  let purchaseDate: Date;
  try {
    // Parse the Square API timestamp string as UTC (Square provides timestamps in UTC)
    // Square SDK returns camelCase (createdAt), with snake_case (created_at) as a fallback
    const utcPurchaseDate = new Date(safeGiftCard.createdAt || safeGiftCard.created_at);

    // Validate the date
    if (isNaN(utcPurchaseDate.getTime())) {
      // If invalid, use current date
      console.warn(`Invalid purchase date for gift card ${safeGiftCard.id}, using current date instead`);
      purchaseDate = new Date();
    } else {
      // Store the raw UTC timestamp directly.
      // The database uses timestamptz so it stores the true moment in time.
      // Date-range queries use getEasternDateRange() which converts ET business day
      // boundaries to UTC before querying — so we MUST keep purchaseDate in UTC here.
      // Previously this called toZonedTime() which creates a misleading JS Date whose
      // .toISOString() returns Eastern local time labeled as UTC (off by 4-5 hours).
      purchaseDate = utcPurchaseDate;
    }
  } catch (error) {
    console.warn(`Error processing purchase date for gift card ${safeGiftCard.id}, using current date instead:`, error);
    purchaseDate = new Date();
  }

  // Extract current balance from balanceMoney
  let amount = 0;
  if (safeGiftCard.balanceMoney?.amount) {
    amount = Number(safeGiftCard.balanceMoney.amount) / 100;
  } else if (safeGiftCard.balance_money?.amount) {
    amount = Number(safeGiftCard.balance_money.amount) / 100;
  }

  // Determine the activation amount.
  // Priority order:
  //   1. Caller-supplied override from the Gift Card Activities API (most accurate)
  //   2. ganMoney field (rarely present, legacy path)
  //   3. Leave as null/0 – the backfill job will correct it later
  let activationAmount: number | null = null;

  if (activationAmountOverride !== undefined && activationAmountOverride > 0) {
    activationAmount = activationAmountOverride;
  } else if (safeGiftCard.ganMoney?.amount) {
    activationAmount = Number(safeGiftCard.ganMoney.amount) / 100;
  } else if (safeGiftCard.gan_money?.amount) {
    activationAmount = Number(safeGiftCard.gan_money.amount) / 100;
  }
  // If no activation amount found, leave null — backfill will resolve it later.

  // Extract GAN (Gift Card Account Number) if available
  let gan = '';
  
  // The GAN is often in the ganData property or reference
  if (safeGiftCard.gan) {
    gan = safeGiftCard.gan;
  } else if (typeof safeGiftCard.ganData === 'object' && safeGiftCard.ganData?.gan) {
    gan = safeGiftCard.ganData.gan;
  } else if (safeGiftCard.reference_id) {
    // Sometimes the reference ID is the GAN
    gan = safeGiftCard.reference_id;
  }
  
  // Check in the Square data JSON for a GAN
  if (!gan && typeof safeGiftCard === 'object') {
    // Deep search for GAN pattern in the object
    const ganMatch = JSON.stringify(safeGiftCard).match(/["']gan["']\s*:\s*["'](\d+)["']/i);
    if (ganMatch && ganMatch[1]) {
      gan = ganMatch[1];
    }
  }
  

  const card: InsertGiftCard = {
    squareId: safeGiftCard.id,
    amount: amount,
    redeemedAmount: 0, // May need to calculate this separately
    activationAmount: activationAmount, // Store the original activation amount
    isActive: safeGiftCard.state === 'ACTIVE',
    purchaseDate,
    squareData: safeGiftCard,
    gan: gan // Add the GAN to the card record
  };

  return card;
}

/**
 * Fetch a map of gift card activation amounts from Square's Gift Card Activities API.
 * Returns a Map keyed by Square gift card ID (e.g. "gftc:...") with the activation
 * amount in dollars as the value.  Only ACTIVATE events are fetched.
 *
 * This is the authoritative source for the original load value of a gift card because
 * the card-listing API only returns the *current* balance, not the original amount.
 */
export async function fetchGiftCardActivitiesMap(): Promise<Map<string, number>> {
  const activationMap = new Map<string, number>();

  if (!process.env.SQUARE_LOCATION_ID) {
    console.error('Square location ID is not configured, cannot fetch gift card activities');
    return activationMap;
  }

  let pageCount = 0;
  const MAX_PAGES = 200;

  console.log('Fetching ACTIVATE gift card activities from Square...');

  let activitiesPage = await squareClient.giftCards.activities.list({
    type: 'ACTIVATE',
    locationId: process.env.SQUARE_LOCATION_ID,
    limit: 50,
  });

  while (pageCount < MAX_PAGES) {
    pageCount++;
    const activities = activitiesPage.data ?? [];

    for (const activity of activities) {
      const giftCardId = activity.giftCardId;
      if (!giftCardId) continue;

      const amountCents = activity.activateActivityDetails?.amountMoney?.amount;
      if (amountCents !== undefined && amountCents !== null) {
        const amountDollars = Number(amountCents) / 100;
        if (!activationMap.has(giftCardId)) {
          activationMap.set(giftCardId, amountDollars);
        }
      }
    }

    console.log(`Gift card activities page ${pageCount}: ${activities.length} ACTIVATE events (total mapped: ${activationMap.size})`);

    if (!activitiesPage.hasNextPage()) break;

    try {
      activitiesPage = await activitiesPage.getNextPage();
    } catch (error) {
      console.error(`Error fetching gift card activities page ${pageCount}:`, error);
      break;
    }
  }

  console.log(`fetchGiftCardActivitiesMap complete: ${activationMap.size} cards with activation amounts`);
  return activationMap;
}

/**
 * Fetch a single page of ACTIVATE gift card activities.
 * Used by the historical backfill to page through all activities with
 * a saved cursor so the job is resumable across server restarts.
 *
 * @param cursor  Cursor from the previous page (undefined for first page)
 * @param sortOrder 'ASC' to page oldest-first (backfill), 'DESC' for incremental
 * @returns       Activities on this page plus the next cursor (undefined = last page)
 */
export async function fetchGiftCardActivitiesPage(
  cursor: string | undefined,
  sortOrder: 'ASC' | 'DESC' = 'DESC'
): Promise<{
  activities: Array<{ giftCardId: string; activationAmountDollars: number; createdAt: Date; squareOrderId?: string }>;
  nextCursor: string | undefined;
}> {
  if (!process.env.SQUARE_LOCATION_ID) {
    console.error('[GiftCardActivitiesPage] Square location ID is not configured');
    return { activities: [], nextCursor: undefined };
  }

  try {
    const activitiesPage = await squareClient.giftCards.activities.list({
      type: 'ACTIVATE',
      locationId: process.env.SQUARE_LOCATION_ID,
      limit: 50,
      cursor,
      sortOrder,
    });

    const rawActivities = activitiesPage.data ?? [];
    const nextCursor: string | undefined = activitiesPage.response?.cursor ?? undefined;

    const activities: Array<{ giftCardId: string; activationAmountDollars: number; createdAt: Date; squareOrderId?: string }> = [];
    for (const activity of rawActivities) {
      const giftCardId = activity.giftCardId;
      if (!giftCardId) continue;
      const amountCents = activity.activateActivityDetails?.amountMoney?.amount;
      if (amountCents == null) continue;
      const createdAt = activity.createdAt ? new Date(activity.createdAt) : new Date(0);
      const squareOrderId: string | undefined =
        activity.orderId ?? activity.activateActivityDetails?.orderId ?? undefined;
      activities.push({
        giftCardId,
        activationAmountDollars: Number(amountCents) / 100,
        createdAt,
        squareOrderId,
      });
    }

    return { activities, nextCursor };
  } catch (error) {
    console.error('[GiftCardActivitiesPage] Error fetching page:', error);
    throw error;
  }
}

/**
 * Fetch ACTIVATE gift card activities created after `since`.
 * Used by the incremental sync to quickly find only new gift card activations
 * without re-scanning the entire 8,000+ card list.
 */
export async function fetchRecentGiftCardActivations(since: Date): Promise<Array<{
  giftCardId: string;
  activationAmountDollars: number;
  createdAt: Date;
  squareOrderId?: string;
}>> {
  const results: Array<{ giftCardId: string; activationAmountDollars: number; createdAt: Date; squareOrderId?: string }> = [];

  if (!process.env.SQUARE_LOCATION_ID) {
    console.error('[IncrementalGiftCardSync] Square location ID is not configured');
    return results;
  }

  let pageCount = 0;

  console.log(`[IncrementalGiftCardSync] Fetching ACTIVATE activities since ${since.toISOString()} (newest-first, stopping at cutoff)`);

  let activitiesPage = await squareClient.giftCards.activities.list({
    type: 'ACTIVATE',
    locationId: process.env.SQUARE_LOCATION_ID,
    limit: 50,
    sortOrder: 'DESC',
  });

  let reachedCutoff = false;
  while (!reachedCutoff) {
    pageCount++;
    const activities = activitiesPage.data ?? [];

    for (const activity of activities) {
      const giftCardId = activity.giftCardId;
      if (!giftCardId) continue;

      const activityTime = activity.createdAt ? new Date(activity.createdAt) : new Date(0);
      if (activityTime <= since) {
        reachedCutoff = true;
        break;
      }

      const amountCents = activity.activateActivityDetails?.amountMoney?.amount;
      if (amountCents == null) continue;

      const squareOrderId: string | undefined =
        activity.orderId ?? activity.activateActivityDetails?.orderId ?? undefined;

      results.push({
        giftCardId,
        activationAmountDollars: Number(amountCents) / 100,
        createdAt: activityTime,
        squareOrderId,
      });
    }

    console.log(`[IncrementalGiftCardSync] Page ${pageCount}: ${activities.length} events scanned, ${results.length} new since cutoff${reachedCutoff ? ' (cutoff reached)' : ''}`);

    if (!activitiesPage.hasNextPage() || activities.length === 0) break;

    try {
      activitiesPage = await activitiesPage.getNextPage();
    } catch (error) {
      console.error(`[IncrementalGiftCardSync] Error on page ${pageCount}:`, error);
      break;
    }
  }

  console.log(`[IncrementalGiftCardSync] Found ${results.length} ACTIVATE events since ${since.toISOString()} (${pageCount} page${pageCount !== 1 ? 's' : ''} scanned)`);
  return results;
}

/**
 * Fetch a single gift card from Square by its Square ID.
 * Used during incremental sync to retrieve the full card object for new activations.
 */
export async function fetchGiftCardById(squareId: string): Promise<any | null> {
  try {
    const response = await squareClient.giftCards.get({ id: squareId });
    if (!response.giftCard) return null;
    return processSafeSquareData(response.giftCard);
  } catch (error) {
    console.error(`[IncrementalGiftCardSync] Error fetching card ${squareId}:`, error);
    return null;
  }
}

// Fetch gift cards from Square API with enhanced error handling
export async function fetchGiftCards(): Promise<any[]> {
  try {
    let allGiftCards: any[] = [];
    let pageCount = 0;
    let giftCardsPage = await squareClient.giftCards.list({ limit: 100 });

    while (true) {
      pageCount++;

      if (!giftCardsPage.data || giftCardsPage.data.length === 0) {
        if (pageCount === 1) console.log('No gift cards found in response');
        break;
      }

      const safeGiftCards = giftCardsPage.data.map((card: any) => {
        try {
          return processSafeSquareData(card);
        } catch (error) {
          console.error(`Error processing gift card:`, error);
          return null;
        }
      }).filter(card => card !== null);

      allGiftCards = [...allGiftCards, ...safeGiftCards];

      if (!giftCardsPage.hasNextPage()) break;

      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        giftCardsPage = await giftCardsPage.getNextPage();
      } catch (error) {
        console.error('Error fetching gift cards page:', error);
        break;
      }
    }

    console.log(`Completed fetching ${allGiftCards.length} total gift cards`);
    return allGiftCards;
  } catch (error) {
    console.error('Error fetching gift cards:', error);
    throw error;
  }
}

export function convertSquareRefundToInsert(refund: Record<string, any>): InsertRefund {
  const amountMoney = refund.amountMoney;
  let amount = 0;
  if (amountMoney && amountMoney.amount !== undefined) {
    amount = (typeof amountMoney.amount === 'bigint'
      ? Number(amountMoney.amount)
      : Number(amountMoney.amount) || 0) / 100;
  }

  return {
    squareRefundId: refund.id,
    squarePaymentId: refund.paymentId || '',
    amount,
    status: refund.status || 'PENDING',
    reason: refund.reason || null,
    createdAt: new Date(refund.createdAt || refund.created_at || new Date()),
    squareData: processSafeSquareData(refund),
  };
}

export async function fetchRefunds(startDate?: Date, endDate?: Date): Promise<any[]> {
  const startTime = Date.now();
  try {
    const now = new Date();
    const beginTime = (startDate || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)).toISOString();
    const endTime = (endDate || new Date()).toISOString();

    console.log(`Fetching refunds from ${beginTime} to ${endTime}`);

    if (!process.env.SQUARE_ACCESS_TOKEN) {
      throw new Error('Square access token is not configured');
    }

    let allRefunds: any[] = [];
    let pageCount = 0;
    const MAX_PAGES = 50;
    const TIMEOUT = 5 * 60 * 1000;

    let refundsPage = await squareClient.refunds.list({
      beginTime,
      endTime,
      sortOrder: 'DESC',
      locationId: process.env.SQUARE_LOCATION_ID,
      limit: 100,
    });

    while (pageCount < MAX_PAGES) {
      pageCount++;
      if (Date.now() - startTime > TIMEOUT) {
        throw new Error('Refund sync timeout reached after 5 minutes');
      }

      const refundsList = refundsPage.data || [];
      allRefunds.push(...refundsList);

      if (!refundsPage.hasNextPage()) break;

      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        refundsPage = await refundsPage.getNextPage();
      } catch (pageError) {
        console.error(`Error fetching refunds page ${pageCount}:`, pageError instanceof Error ? pageError.message : pageError);
        throw pageError;
      }
    }

    console.log(`Successfully fetched ${allRefunds.length} refunds from Square API in ${Date.now() - startTime}ms`);
    return allRefunds;
  } catch (error) {
    console.error('Error in fetchRefunds:', error instanceof Error ? error.message : error);
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
function mapSquareCategory(itemName: string, itemType?: string): Category {
  // CRITICAL FIX: First check explicitly for GIFT_CARD type
  if (itemType === 'GIFT_CARD') {
    return 'giftCard';
  }
  
  // Fallback to text matching
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
    const catalogPage = await squareClient.catalog.list({
      types: "ITEM",
    });

    const giftCardItems = (catalogPage.data || []).filter((item: any) => {
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