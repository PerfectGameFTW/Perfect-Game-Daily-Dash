// Add BigInt serialization override at the top
if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function() {
    return this.toString();
  };
}

import { Client, Environment } from 'square';
import { toZonedTime } from 'date-fns-tz';
import dotenv from 'dotenv';

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

// Fetch orders from Square API
export async function fetchOrders(startDate?: Date, endDate?: Date): Promise<any[]> {
  try {
    const now = new Date();
    const start = startDate || new Date(now.setDate(now.getDate() - 30)); // Default to last 30 days
    const end = endDate || new Date();

    // Format dates for Square API
    const startTime = start.toISOString();
    const endTime = end.toISOString();

    console.log(`Fetching orders from ${startTime} to ${endTime}`);

    // Create search request body for v29.0.0
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
      // Include all relevant fields to analyze gift card purchases
      returnEntries: true,
      limit: 500 // Increased to get more results on a single request
    };

    // Make API request to Square Orders API
    const response = await squareClient.ordersApi.searchOrders(searchRequest);

    // Extract orders from the SearchOrdersResponse
    const orders = response.result.orders || [];
    console.log(`Fetched ${orders.length} orders from Square API between ${startTime} and ${endTime}`);

    // Look for gift card items
    let giftCardOrders = 0;
    let giftCardAmount = 0;

    for (const order of orders) {
      if (order.lineItems) {
        for (const item of order.lineItems) {
          if (
            (item.name && item.name.toLowerCase().includes('gift card')) ||
            (item.catalogObjectId && item.catalogObjectId.includes('GIFT_CARD')) ||
            (item.note && item.note.toLowerCase().includes('gift card')) ||
            (item.itemType && item.itemType === 'GIFT_CARD')
          ) {
            giftCardOrders++;
            const itemAmount = item.basePriceMoney && item.basePriceMoney.amount 
              ? Number(item.basePriceMoney.amount) / 100 
              : 0;
            giftCardAmount += itemAmount;

            console.log(`Found gift card item! Order ID: ${order.id}, Item: ${item.name}, Amount: $${itemAmount}`);
          }
        }
      }
    }

    if (giftCardAmount > 0) {
      console.log(`GIFT CARD SUMMARY: Found ${giftCardOrders} gift card orders totaling $${giftCardAmount.toFixed(2)}`);
    }

    return orders;
  } catch (error) {
    console.error('Error fetching orders from Square:', error);
    if (error && typeof error === 'object') {
      console.error('Detailed error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    }
    return [];
  }
}

// Add helper function to check if a payment is a gift card redemption
function isGiftCardRedemption(payment: any): boolean {
  return (
    (payment.sourceType && payment.sourceType === 'GIFT_CARD') || 
    (payment.cardDetails && payment.cardDetails.entryMethod === 'GIFT_CARD')
  );
}

// Fetch payments from Square API
export async function fetchPayments(startDate?: Date, endDate?: Date): Promise<any[]> {
  try {
    const now = new Date();
    const start = startDate || new Date(now.setDate(now.getDate() - 30));
    const end = endDate || new Date();

    // Format dates for Square API
    const beginTime = start.toISOString();
    const endTime = end.toISOString();

    // Create or update sync state
    let syncState = await pgStorage.getSyncState('payments');
    if (!syncState) {
      syncState = await pgStorage.createSyncState({
        syncType: 'payments',
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

    console.log(`Starting payments sync from ${beginTime} to ${endTime}`);

    let allPayments: any[] = [];
    let cursor: string | undefined = syncState.cursor || undefined;
    let hasMorePages = true;
    let pageCount = syncState.currentPage;

    while (hasMorePages) {
      pageCount++;
      console.log(`Fetching payments page ${pageCount}${cursor ? ' with cursor' : ''}`);

      try {
        const response = await squareClient.paymentsApi.listPayments(
          beginTime,
          endTime,
          'DESC',
          cursor,
          process.env.SQUARE_LOCATION_ID,
          undefined,
          undefined,
          undefined,
          undefined,
          100
        );

        const payments = response.result.payments || [];

        // Process each payment to identify gift card redemptions
        for (const payment of payments) {
          if (isGiftCardRedemption(payment)) {
            console.log(`Found gift card redemption payment: ${payment.id}`);
            // Add flags to identify redemption in downstream processing
            payment.isGiftCardRedemption = true;
            payment.redemptionAmount = payment.amountMoney 
              ? Number(payment.amountMoney.amount) / 100 
              : 0;
          }
        }

        allPayments = [...allPayments, ...payments];

        // Update sync state
        await pgStorage.updateSyncState(syncState.id, {
          currentPage: pageCount,
          processedCount: allPayments.length,
          cursor: response.result.cursor || '',
          lastSyncedAt: new Date(),
          lastCheckpoint: {
            lastProcessedId: payments[payments.length - 1]?.id,
            timestamp: new Date().toISOString()
          }
        });

        cursor = response.result.cursor;
        hasMorePages = !!cursor;

        if (hasMorePages) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error('Error fetching payments page:', error);

        // Update sync state with error
        await pgStorage.updateSyncState(syncState.id, {
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unknown error occurred',
          lastSyncedAt: new Date()
        });

        hasMorePages = false;
      }
    }

    // Mark sync as complete
    await pgStorage.updateSyncState(syncState.id, {
      isComplete: true,
      status: 'completed',
      lastSyncedAt: new Date(),
      totalCount: allPayments.length
    });

    console.log(`Completed fetching ${allPayments.length} total payments`);

    const orders = await fetchOrders(startDate, endDate);
    console.log(`Fetched ${orders.length} orders from Square`);

    const orderMap = new Map();
    orders.forEach(order => {
      orderMap.set(order.id, order);
    });

    let paymentsWithOrders = 0;
    allPayments.forEach(payment => {
      if (payment.orderId && orderMap.has(payment.orderId)) {
        payment.orderData = orderMap.get(payment.orderId);
        paymentsWithOrders++;
      }
    });

    console.log(`Successfully linked ${paymentsWithOrders} payments with their orders`);

    return allPayments;
  } catch (error) {
    console.error('Error fetching payments from Square:', error);
    throw error;
  }
}

// Convert Square payment to our Transaction model
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

  // Determine category based on payment information
  let category: Category = 'retail'; // Default

  // Log detailed payment data for troubleshooting
  if (payment.id && payment.orderId) {
    console.log(`Payment ${payment.id} linked to order ${payment.orderId}`);
  }

  // IMPORTANT: We need to handle gift card purchases differently than gift card payments
  // Gift card PURCHASES - When a customer BUYS a gift card (this should be categorized as a gift card sale)
  // Gift card PAYMENTS - When a customer PAYS USING a gift card (this should NOT be categorized as gift card)

  // ENHANCED GIFT CARD DETECTION LOGIC

  // First check if this is a payment USING a gift card (not a gift card purchase)
  const paidWithGiftCard = 
    (payment.sourceType && payment.sourceType === 'GIFT_CARD') || 
    (payment.cardDetails && payment.cardDetails.entryMethod === 'GIFT_CARD');

  if (paidWithGiftCard) {
    // This is someone paying WITH a gift card, NOT a gift card sale
    // We should categorize based on what they bought, not as a gift card
    console.log(`Payment USING gift card detected: ${payment.id}, amount: $${amount}`);

    // Try to determine category from order name or note
    if (payment.orderId && payment.orderName) {
      category = mapSquareCategory(payment.orderName);
    } else if (payment.note) {
      category = mapSquareCategory(payment.note);
    }
  } 
  // If it's not paid with a gift card, check if it's a gift card PURCHASE
  else {
    let isGiftCardPurchase = false;

    // DIRECT ORDERS API APPROACH - Check for item_type = GIFT_CARD in order line items
    if (payment.orderId && payment.orderData) {
      try {
        // Parse order data if it's stored as a string
        const orderData = typeof payment.orderData === 'string' 
          ? JSON.parse(payment.orderData) 
          : payment.orderData;

        // Check for line items with GIFT_CARD type - this is the most reliable method
        if (orderData.lineItems && Array.isArray(orderData.lineItems)) {
          const giftCardItems = orderData.lineItems.filter((item: any) => 
            item.itemType === 'GIFT_CARD' || 
            (item.name && item.name.toLowerCase().includes('gift card'))
          );

          if (giftCardItems.length > 0) {
            isGiftCardPurchase = true;
            console.log(`✅ Found gift card purchase in order ${payment.orderId} via line items`);

            // Log detailed info about the gift card items
            giftCardItems.forEach((item: any, index: number) => {
              const itemAmount = item.basePriceMoney 
                ? Number(item.basePriceMoney.amount) / 100 
                : 0;

              console.log(`  Gift Card Item #${index + 1}:`);
              console.log(`  - Name: ${item.name || 'N/A'}`);
              console.log(`  - Item Type: ${item.itemType || 'N/A'}`);
              console.log(`  - Amount: $${itemAmount}`);
              console.log(`  - Quantity: ${item.quantity || 1}`);
            });
          }
        }
      } catch (error) {
        console.warn(`Error checking order data for gift cards in payment ${payment.id}:`, error);
      }
    }

    // BACKUP PAYMENT-ONLY DETECTION - Used if order data isn't available
    if (!isGiftCardPurchase) {
      const orderName = (payment.orderName || '').toLowerCase();
      const note = (payment.note || '').toLowerCase();

      // Check for gift card indicators in various fields
      isGiftCardPurchase = 
        orderName.includes('gift card') ||
        note.includes('gift card') ||
        (payment.itemizations && Array.isArray(payment.itemizations) && 
          payment.itemizations.some((item: any) => 
            (item.name && item.name.toLowerCase().includes('gift card')) ||
            (item.itemType && item.itemType === 'GIFT_CARD')
          )
        );

      if (isGiftCardPurchase) {
        console.log(`✅ Found gift card purchase in payment ${payment.id} via text search`);
      }
    }

    // Generalized logging for all gift card purchases regardless of date
    if (isGiftCardPurchase && process.env.DEBUG_GIFT_CARDS) {
      console.log(`📊 Gift card purchase detected in payment ${payment.id} - Amount: $${amount}`);
    }

    // SET CATEGORY based on our detection logic
    if (isGiftCardPurchase) {
      category = 'giftCard';
      console.log(`Identified gift card PURCHASE: ${payment.id}, amount: $${amount}`);
    } 
    // Otherwise use standard category detection
    else if (payment.orderId) {
      category = payment.orderName ? mapSquareCategory(payment.orderName) : 'retail';
    } else if (payment.note) {
      category = mapSquareCategory(payment.note);
    }
  }

  // Parse and convert the timestamp from UTC to Eastern Time for proper business day alignment
  let timestamp: Date;
  try {
    // Parse the Square API timestamp string as UTC (Square provides timestamps in UTC)
    const utcTimestamp = new Date(payment.createdAt);

    // Validate the date
    if (isNaN(utcTimestamp.getTime())) {
      // If invalid, use current date
      console.warn(`Invalid timestamp for payment ${payment.id}, using current date instead`);
      timestamp = new Date();
    } else {
      // Convert the UTC timestamp to a date in Eastern timezone
      // This preserves the exact same moment in time but represents it in Eastern timezone
      // This ensures that midnight-to-midnight in Eastern time is properly preserved
      timestamp = toZonedTime(utcTimestamp, EASTERN_TIMEZONE);

      // Log the timestamp conversion for debugging
      console.log(`Payment ${payment.id} timestamp conversion:`, {
        original: payment.createdAt,
        utc: utcTimestamp.toISOString(),
        eastern: formatInTimeZone(timestamp, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
      });
    }
  } catch (error) {
    console.warn(`Error processing timestamp for payment ${payment.id}, using current date instead:`, error);
    timestamp = new Date();
  }

  // Convert payment data to handle BigInt values
  let cleanedPaymentData: Record<string, any> = {};
  try {
    // Try the JSON parse/stringify approach with replacer
    cleanedPaymentData = JSON.parse(JSON.stringify(payment, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value
    ));
  } catch (error) {
    console.warn(`Error stringifying payment ${payment.id}, using manual conversion:`, error);
    // Manual fallback - create a new object without BigInt values
    Object.keys(payment).forEach(key => {
      const value = (payment as Record<string, any>)[key];
      if (typeof value === 'bigint') {
        cleanedPaymentData[key] = value.toString();
      } else if (typeof value === 'object' && value !== null) {
        // For nested objects, we'll just store a simplified version
        try {
          cleanedPaymentData[key] = JSON.stringify(value);
        } catch (e) {
          cleanedPaymentData[key] = '[Complex Object]';
        }
      } else {
        cleanedPaymentData[key] = value;
      }
    });
  }

  // Map to our transaction model
  const transaction: InsertTransaction = {
    squareId: payment.id,
    amount,
    categoryId: category,
    status: mapSquareStatus(payment.status),
    timestamp,
    squareData: cleanedPaymentData
  };

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

export { squareClient };