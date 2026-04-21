// Add BigInt serialization override at the top level
// This is a safer approach that doesn't modify the prototype
(BigInt.prototype as any).toJSON = function() {
  return this.toString();
};

// Add testConnection method
export async function testConnection(): Promise<{ success: boolean, message: string }> {
 try {
   if (!process.env.SQUARE_ACCESS_TOKEN) {
     throw new ExternalServiceError(
       'Square access token is not configured',
       { code: 'SQUARE_TOKEN_NOT_CONFIGURED' },
     );
   }

   const response = await squareClient.locations.list();

   if (!response.locations) {
     throw new ExternalServiceError(
       'Invalid response from Square API',
       { code: 'SQUARE_INVALID_RESPONSE' },
     );
   }

   logger.info('square.test_connection.ok', { count: response.locations.length });

   return {
     success: true,
     message: 'Successfully connected to Square API'
   };
 } catch (error) {
   logger.error('square.test_connection.failed', errorContext(error));

   if (error instanceof ExternalServiceError) throw error;
   throw new ExternalServiceError(
     `Failed to connect to Square API: ${error instanceof Error ? error.message : 'Unknown error'}`,
     { code: 'SQUARE_CONNECTION_FAILED' },
   );
 }
}

import { pgStorage } from './pgStorage';
import { ExternalServiceError } from './errors';
import { logger, errorContext } from './logger';
import { SquareClient, SquareEnvironment } from 'square';
import {
  Transaction, InsertTransaction,
  GiftCard, InsertGiftCard,
  InsertRefund,
  Category, TransactionStatus, syncState, InsertOrder, InsertOrderLineItem, InsertOrderModifier, InsertOrderDiscount
} from '@shared/schema';
import { formatInTimeZone } from 'date-fns-tz';
import dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import { orders } from '@shared/schema';
import { lookupCategorySync } from './services/catalogService';


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
    logger.error('square.process_data.failed', errorContext(error));
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

    logger.info('square.fetchOrders.start');

    if (!process.env.SQUARE_ACCESS_TOKEN) {
      throw new ExternalServiceError(
        'Square access token is not configured',
        { code: 'SQUARE_TOKEN_NOT_CONFIGURED' },
      );
    }

    if (!process.env.SQUARE_LOCATION_ID) {
      throw new ExternalServiceError(
        'Square location ID is not configured',
        { code: 'SQUARE_LOCATION_NOT_CONFIGURED' },
      );
    }

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
          if (page === 1) logger.warn('square.fetchOrders.empty_response');
          break;
        }

        const pageOrders = response.orders.filter(o => o && o.id);
        allOrders.push(...pageOrders);
        cursor = response.cursor ?? undefined;

        logger.info('square.fetchOrders.page', { page, count: pageOrders.length });
      } while (cursor);

      logger.info('square.fetchOrders.done', { count: allOrders.length, pageCount: page });

      return allOrders;
    } catch (apiError) {
      logger.error('square.fetchOrders.api_error', errorContext(apiError));

      throw new ExternalServiceError(
        `Square Orders API error: ${apiError instanceof Error ? apiError.message : 'Unknown error'}`,
        { code: 'SQUARE_ORDERS_API_ERROR' },
      );
    }
  } catch (error) {
    logger.error('square.fetchOrders.failed', errorContext(error));
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
      logger.error('square.invalid_order.not_object');
      throw new ExternalServiceError(
        'Invalid Square order data: not an object',
        { code: 'SQUARE_INVALID_ORDER_DATA' },
      );
    }

    // Ensure all required fields are present
    if (!safeOrder.id) {
      logger.error('square.invalid_order.missing_id');
      throw new ExternalServiceError(
        'Invalid Square order data: missing id',
        { code: 'SQUARE_INVALID_ORDER_DATA' },
      );
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
        hasGiftCardItems = true;
        logger.info('square.order.gift_card_items', {
          orderId: safeOrder.id,
          count: giftCardItems.length,
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
    logger.error('square.convert_order.failed', errorContext(error));
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
      const squareOrders = response.orders ?? [];
      for (const squareOrder of squareOrders) {
        try {
          results.push(convertSquareOrderToOrder(squareOrder));
        } catch {
          // skip malformed orders
        }
      }
    } catch (error) {
      logger.error('square.fetchOrdersByIds.batch_error', { count: batch.length, ...errorContext(error) });
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
    // Note: do NOT log the raw line item — `note` may contain customer
    // PII (party names, contact info) entered by staff at the register.
    logger.debug('square.line_item.missing_name');
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
    
    logger.debug('square.line_item.gift_card');
    
    // Add gift card metadata to the squareData
    safeLineItem.isGiftCard = true;
    // Prioritize using the base price for gift card value (before discounts)
    safeLineItem.giftCardAmount = basePrice || finalPrice;
  }

  const catalogObjectId = safeLineItem.catalogObjectId || null;
  const catalogCategory = lookupCategorySync(catalogObjectId);
  let category = catalogCategory || mapSquareCategory(itemName, safeLineItem.itemType || '');
  
  return {
    orderId,
    name: itemName,
    quantity: safeLineItem.quantity || 1,
    basePriceMoney: safeLineItem.basePriceMoney ? Number(safeLineItem.basePriceMoney.amount) / 100 : 0,
    totalMoney: safeLineItem.totalMoney ? Number(safeLineItem.totalMoney.amount) / 100 : 0,
    category: category,
    productId: catalogObjectId,
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

      // Add additional information to the payment object
      payment.isGiftCardRedemption = true;
      payment.sourceId = sourceId;
      payment.redemptionAmount = payment.amountMoney
        ? Number(payment.amountMoney.amount) / 100
        : 0;
    }

    return isGiftCard;
  } catch (error) {
    logger.error('square.gift_card_redemption_check.failed', errorContext(error));
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

    logger.info('square.fetchPayments.start');

    if (!process.env.SQUARE_ACCESS_TOKEN) {
      throw new ExternalServiceError(
        'Square access token is not configured',
        { code: 'SQUARE_TOKEN_NOT_CONFIGURED' },
      );
    }

    if (!process.env.SQUARE_LOCATION_ID) {
      throw new ExternalServiceError(
        'Square location ID is not configured',
        { code: 'SQUARE_LOCATION_NOT_CONFIGURED' },
      );
    }

    let allPayments: any[] = [];
    let pageCount = 0;
    const MAX_PAGES = 50;
    const TIMEOUT = 5 * 60 * 1000;

    let paymentsPage = await squareClient.payments.list({
      beginTime,
      endTime,
      sortOrder: 'DESC',
      locationId: process.env.SQUARE_LOCATION_ID
    });

    while (pageCount < MAX_PAGES) {
      pageCount++;
      const pageStartTime = Date.now();
      logger.debug('square.fetchPayments.page_start', { page: pageCount });

      if (Date.now() - startTime > TIMEOUT) {
        throw new ExternalServiceError(
          'Sync timeout reached after 5 minutes',
          { code: 'SQUARE_SYNC_TIMEOUT' },
        );
      }

      try {

        const pageEndTime = Date.now();
        const pageProcessingTime = pageEndTime - pageStartTime;

        logger.info('square.fetchPayments.page', {
          page: pageCount,
          count: paymentsPage.data?.length || 0,
          durationMs: pageProcessingTime,
        });

        const payments = paymentsPage.data || [];

        if (!Array.isArray(payments)) {
          throw new ExternalServiceError(
            `Invalid response format from Square API: expected array, got ${typeof payments}`,
            { code: 'SQUARE_INVALID_RESPONSE' },
          );
        }

        // Process each payment
        for (const payment of payments) {
          try {
            if (isGiftCardRedemption(payment)) {
              logger.debug('square.payment.gift_card_redemption', { paymentId: payment.id });
            }
            allPayments.push(payment);
          } catch (paymentError) {
            logger.error('square.payment.process_failed', { paymentId: payment.id, ...errorContext(paymentError) });
          }
        }

        if (!paymentsPage.hasNextPage()) break;

        await new Promise(resolve => setTimeout(resolve, 100));
        paymentsPage = await paymentsPage.getNextPage();
      } catch (pageError) {
        logger.error('square.fetchPayments.page_error', {
          page: pageCount,
          durationMs: Date.now() - startTime,
          ...errorContext(pageError),
        });
        throw new ExternalServiceError(
          `Failed to fetch page ${pageCount}: ${pageError instanceof Error ? pageError.message : 'Unknown error'}`,
          { code: 'SQUARE_PAYMENTS_API_ERROR' },
        );
      }
    }

    const totalTime = Date.now() - startTime;
    const hitPageCap = pageCount >= MAX_PAGES;
    if (hitPageCap) {
      logger.warn('square.fetchPayments.page_cap', { pageCount: MAX_PAGES, durationMs: totalTime, hitPageCap: true });
    }

    logger.info('square.fetchPayments.done', { count: allPayments.length, durationMs: totalTime });
    if (opts?.returnMeta) {
      return { payments: allPayments, hitPageCap };
    }
    return allPayments;
  } catch (error) {
    logger.error('square.fetchPayments.failed', {
      durationMs: Date.now() - startTime,
      ...errorContext(error),
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

  let category: Category = 'retail';

  let catalogCategory: string | null = null;
  if (payment.orderId && payment.orderData) {
    try {
      const orderData = typeof payment.orderData === 'string'
        ? JSON.parse(payment.orderData)
        : payment.orderData;
      if (orderData.lineItems && Array.isArray(orderData.lineItems)) {
        for (const item of orderData.lineItems) {
          if (item.catalogObjectId) {
            const cat = lookupCategorySync(item.catalogObjectId);
            if (cat) { catalogCategory = cat; break; }
          }
        }
      }
    } catch (_) {}
  }

  if (paidWithGiftCard) {
    logger.debug('square.payment.paid_with_gift_card', { paymentId: payment.id });

    if (catalogCategory) {
      category = catalogCategory;
    } else if (payment.orderId && payment.orderName) {
      category = mapSquareCategory(payment.orderName);
    } else if (payment.note) {
      category = mapSquareCategory(payment.note);
    }
  } else {
    let isGiftCardPurchase = false;

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
            logger.debug('square.payment.gift_card_purchase', { orderId: payment.orderId });
          }
        }
      } catch (error) {
        logger.error('square.payment.order_check_failed', errorContext(error));
      }
    }

    if (isGiftCardPurchase) {
      category = 'giftCard';
    } else if (catalogCategory) {
      category = catalogCategory;
    } else {
      category = payment.orderName ? mapSquareCategory(payment.orderName) : 'retail';
    }
  }

  // Parse and convert the timestamp
  let timestamp: Date = new Date(payment.createdAt);
  if (isNaN(timestamp.getTime())) {
    logger.warn('square.payment.invalid_timestamp', { paymentId: payment.id });
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

  // Log transaction creation for gift card payments — IDs only.
  if (payment.isGiftCardRedemption) {
    logger.debug('square.transaction.created_from_gift_card', { squareId: transaction.squareId });
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
      logger.warn('square.gift_card.invalid_date', { giftCardId: safeGiftCard.id });
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
    logger.warn('square.gift_card.date_error', { giftCardId: safeGiftCard.id, ...errorContext(error) });
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
    logger.error('square.gift_card_activities.no_location');
    return activationMap;
  }

  let pageCount = 0;
  const MAX_PAGES = 200;

  logger.info('square.gift_card_activities.start');

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

    logger.debug('square.gift_card_activities.page', { page: pageCount, count: activities.length });

    if (!activitiesPage.hasNextPage()) break;

    try {
      activitiesPage = await activitiesPage.getNextPage();
    } catch (error) {
      logger.error('square.gift_card_activities.page_error', { page: pageCount, ...errorContext(error) });
      break;
    }
  }

  logger.info('square.gift_card_activities.done', { count: activationMap.size });
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
    logger.error('square.gift_card_activities_page.no_location');
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
        activity.activateActivityDetails?.orderId ?? undefined;
      activities.push({
        giftCardId,
        activationAmountDollars: Number(amountCents) / 100,
        createdAt,
        squareOrderId,
      });
    }

    return { activities, nextCursor };
  } catch (error) {
    logger.error('square.gift_card_activities_page.error', errorContext(error));
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
    logger.error('square.gift_card_incremental.no_location');
    return results;
  }

  let pageCount = 0;

  logger.info('square.gift_card_incremental.start');

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
        activity.activateActivityDetails?.orderId ?? undefined;

      results.push({
        giftCardId,
        activationAmountDollars: Number(amountCents) / 100,
        createdAt: activityTime,
        squareOrderId,
      });
    }

    logger.debug('square.gift_card_incremental.page', { page: pageCount, count: results.length });

    if (!activitiesPage.hasNextPage() || activities.length === 0) break;

    try {
      activitiesPage = await activitiesPage.getNextPage();
    } catch (error) {
      logger.error('square.gift_card_incremental.page_error', { page: pageCount, ...errorContext(error) });
      break;
    }
  }

  logger.info('square.gift_card_incremental.done', { count: results.length, pageCount });
  return results;
}

export async function fetchRecentGiftCardRedemptions(since: Date): Promise<{ events: Array<{
  giftCardId: string;
  amountDollars: number;
  createdAt: Date;
}>; complete: boolean }> {
  const results: Array<{ giftCardId: string; amountDollars: number; createdAt: Date }> = [];

  if (!process.env.SQUARE_LOCATION_ID) {
    logger.error('square.redeem_monitor.no_location');
    return { events: results, complete: true };
  }

  let pageCount = 0;

  logger.info('square.redeem_monitor.start');

  let activitiesPage = await squareClient.giftCards.activities.list({
    type: 'REDEEM',
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

      const amountCents = activity.redeemActivityDetails?.amountMoney?.amount;
      if (amountCents == null) continue;

      results.push({
        giftCardId,
        amountDollars: Math.abs(Number(amountCents)) / 100,
        createdAt: activityTime,
      });
    }

    if (!activitiesPage.hasNextPage() || activities.length === 0) break;

    try {
      activitiesPage = await activitiesPage.getNextPage();
    } catch (error) {
      logger.error('square.redeem_monitor.page_error', { page: pageCount, count: results.length, ...errorContext(error) });
      return { events: results, complete: false };
    }
  }

  logger.info('square.redeem_monitor.done', { count: results.length, pageCount });
  return { events: results, complete: true };
}

export async function fetchGiftCardRedeemActivities(
  beginTime: string,
  endTime: string
): Promise<Array<{
  giftCardId: string;
  amountDollars: number;
  createdAt: string;
}>> {
  const results: Array<{ giftCardId: string; amountDollars: number; createdAt: string }> = [];

  if (!process.env.SQUARE_LOCATION_ID) {
    logger.error('square.redeem_activities.no_location');
    return results;
  }

  let pageCount = 0;
  const MAX_PAGES = 100;

  let activitiesPage = await squareClient.giftCards.activities.list({
    type: 'REDEEM',
    locationId: process.env.SQUARE_LOCATION_ID,
    beginTime,
    endTime,
    limit: 50,
    sortOrder: 'DESC',
  });

  while (pageCount < MAX_PAGES) {
    pageCount++;
    const activities = activitiesPage.data ?? [];

    for (const activity of activities) {
      const giftCardId = activity.giftCardId;
      if (!giftCardId) continue;
      const amountCents = activity.redeemActivityDetails?.amountMoney?.amount;
      if (amountCents == null) continue;
      results.push({
        giftCardId,
        amountDollars: Math.abs(Number(amountCents)) / 100,
        createdAt: activity.createdAt ?? '',
      });
    }

    if (!activitiesPage.hasNextPage() || activities.length === 0) break;
    try {
      activitiesPage = await activitiesPage.getNextPage();
    } catch (error) {
      logger.error('square.redeem_activities.page_error', { page: pageCount, ...errorContext(error) });
      break;
    }
  }

  logger.info('square.redeem_activities.done', { count: results.length });
  return results;
}

export async function fetchGiftCardActivateActivity(
  giftCardId: string
): Promise<{ squareOrderId?: string } | null> {
  if (!process.env.SQUARE_LOCATION_ID) return null;

  try {
    const page = await squareClient.giftCards.activities.list({
      giftCardId,
      type: 'ACTIVATE',
      locationId: process.env.SQUARE_LOCATION_ID,
      limit: 1,
    });

    const activity = page.data?.[0];
    if (!activity) return null;

    return {
      squareOrderId: activity.activateActivityDetails?.orderId ?? undefined,
    };
  } catch (error) {
    logger.error('square.activate_activity.error', { giftCardId, ...errorContext(error) });
    return null;
  }
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
  } catch (error: unknown) {
    const err = error as Record<string, unknown>;
    const status = err?.statusCode ?? err?.status ?? (err?.response as Record<string, unknown>)?.status;
    if (status === 404) {
      logger.debug('square.gift_card_fetch.not_found', { squareId });
      return null;
    }
    throw error;
  }
}

// Fetch gift cards from Square API with enhanced error handling
export async function fetchGiftCards(): Promise<{ cards: any[]; complete: boolean }> {
  try {
    let allGiftCards: any[] = [];
    let pageCount = 0;
    let paginationFailed = false;
    let giftCardsPage = await squareClient.giftCards.list({ limit: 100 });

    while (true) {
      pageCount++;

      if (!giftCardsPage.data || giftCardsPage.data.length === 0) {
        if (pageCount === 1) logger.warn('square.gift_cards.empty_response');
        break;
      }

      const safeGiftCards = giftCardsPage.data.map((card: any) => {
        try {
          return processSafeSquareData(card);
        } catch (error) {
          logger.error('square.gift_cards.process_error', errorContext(error));
          return null;
        }
      }).filter(card => card !== null);

      allGiftCards = [...allGiftCards, ...safeGiftCards];

      if (!giftCardsPage.hasNextPage()) break;

      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        giftCardsPage = await giftCardsPage.getNextPage();
      } catch (error) {
        logger.error('square.gift_cards.page_error', errorContext(error));
        paginationFailed = true;
        break;
      }
    }

    logger.info('square.gift_cards.done', { count: allGiftCards.length });
    return { cards: allGiftCards, complete: !paginationFailed };
  } catch (error) {
    logger.error('square.gift_cards.failed', errorContext(error));
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

    logger.info('square.fetchRefunds.start');

    if (!process.env.SQUARE_ACCESS_TOKEN) {
      throw new ExternalServiceError(
        'Square access token is not configured',
        { code: 'SQUARE_TOKEN_NOT_CONFIGURED' },
      );
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
        throw new ExternalServiceError(
          'Refund sync timeout reached after 5 minutes',
          { code: 'SQUARE_SYNC_TIMEOUT' },
        );
      }

      const refundsList = refundsPage.data || [];
      allRefunds.push(...refundsList);

      if (!refundsPage.hasNextPage()) break;

      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        refundsPage = await refundsPage.getNextPage();
      } catch (pageError) {
        logger.error('square.fetchRefunds.page_error', { page: pageCount, ...errorContext(pageError) });
        throw pageError;
      }
    }

    logger.info('square.fetchRefunds.done', { count: allRefunds.length, durationMs: Date.now() - startTime });
    return allRefunds;
  } catch (error) {
    logger.error('square.fetchRefunds.failed', errorContext(error));
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

    logger.info('square.catalog.gift_card_items', { count: giftCardItems.length });
    return giftCardItems;
  } catch (error) {
    logger.error('square.catalog.search_error', errorContext(error));
    return [];
  }
}

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

    logger.info('sync.orders.start');

    // Fetch orders from Square
    const orders = await fetchOrders(startDate, endDate);
    logger.info('sync.orders.fetched', { count: orders.length });

    // Process each order
    let successCount = 0;
    let errorCount = 0;

    for (const order of orders) {
      try {
        // Convert order to our format
        const insertOrder = convertSquareOrderToOrder(order);

        // Create order in database
        const savedOrder = await pgStorage.createOrder(insertOrder);
        logger.debug('sync.orders.saved', { squareId: order.id });

        // Process line items
        if (order.lineItems && Array.isArray(order.lineItems)) {
          for (const lineItem of order.lineItems) {
            try {
              const insertLineItem = convertSquareLineItemToOrderLineItem(lineItem, savedOrder.id);
              const savedLineItem = await pgStorage.createOrderItem(insertLineItem);
              // Don't log line-item names — staff sometimes encode customer
              // info into them (e.g. "John's birthday cake").

              // Process modifiers for this line item
              if (lineItem.modifiers && Array.isArray(lineItem.modifiers)) {
                for (const modifier of lineItem.modifiers) {
                  try {
                    const insertModifier = convertSquareModifierToOrderModifier(modifier, savedLineItem.id);
                    await pgStorage.createOrderModifier(insertModifier);
                  } catch (modifierError) {
                    logger.error('sync.orders.modifier_error', { orderId: order.id, ...errorContext(modifierError) });
                  }
                }
              }
            } catch (lineItemError) {
              logger.error('sync.orders.line_item_error', { orderId: order.id, ...errorContext(lineItemError) });
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
              logger.error('sync.orders.discount_error', { orderId: order.id, ...errorContext(discountError) });
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
        logger.error('sync.orders.process_failed', { orderId: order.id, ...errorContext(error) });
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

    logger.info('sync.orders.done', { processed: successCount, failed: errorCount });
  } catch (error) {
    logger.error('sync.orders.failed', errorContext(error));
    throw error;
  }
}

export { squareClient };