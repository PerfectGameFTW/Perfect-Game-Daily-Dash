import { Client, Environment } from 'square';
import { 
  Transaction, InsertTransaction,
  GiftCard, InsertGiftCard,
  Category, TransactionStatus
} from '@shared/schema';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Square client with production environment
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN || '',
  environment: Environment.Production  // Force production environment
});

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

// Fetch payments from Square API
export async function fetchPayments(startDate?: Date, endDate?: Date): Promise<any[]> {
  try {
    const now = new Date();
    const start = startDate || new Date(now.setDate(now.getDate() - 30)); // Default to last 30 days
    const end = endDate || new Date();
    
    // Format dates for Square API
    const beginTime = start.toISOString();
    const endTime = end.toISOString();
    
    console.log(`Fetching payments from ${beginTime} to ${endTime}`);
    
    // Implement pagination to get ALL payments
    let allPayments: any[] = [];
    let cursor: string | undefined = undefined;
    let hasMorePages = true;
    let pageCount = 0;
    
    // Loop until we've fetched all pages
    while (hasMorePages) {
      pageCount++;
      console.log(`Fetching payments page ${pageCount}${cursor ? ' with cursor' : ''}`);
      
      // Use date range with listPayments - Square API v29 requires specific parameters
      // For Square API v29, the parameters are in this exact order:
      // beginTime, endTime, sortOrder, cursor, locationId, total, last4, cardBrand, limit
      try {
        const response = await squareClient.paymentsApi.listPayments(
          beginTime,          // beginTime - string
          endTime,            // endTime - string
          'DESC',             // sortOrder - string, must be 'ASC' or 'DESC'
          cursor,             // cursor - string
          process.env.SQUARE_LOCATION_ID, // locationId - optional string
          undefined,          // total - bigint
          undefined,          // last4 - string
          undefined,          // cardBrand - string
          100                 // limit - number
        );
        
        // Extract payments from the response
        const payments = response.result.payments || [];
        allPayments = [...allPayments, ...payments];
        
        // Check if there are more pages
        cursor = response.result.cursor;
        hasMorePages = !!cursor;
        
        console.log(`Fetched ${payments.length} payments on page ${pageCount}. Total so far: ${allPayments.length}`);
        
        // Add a small delay to avoid rate limiting
        if (hasMorePages) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error('Error fetching payments page:', error);
        // If we get an error, break the loop but return what we have so far
        hasMorePages = false;
      }
    }
    
    console.log(`Completed fetching ${allPayments.length} total payments from Square for date range ${beginTime} to ${endTime}`);
    return allPayments;
  } catch (error) {
    console.error('Error fetching payments from Square:', error);
    // Log the detailed error if it's an object
    if (error && typeof error === 'object') {
      console.error('Detailed error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    }
    return [];
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
    // Multiple ways to detect a gift card:
    // 1. Check reference data for direct identification
    const paymentId = payment.id || '';
    const orderId = payment.orderId || '';
    
    // Known gift card transaction IDs for Feb 25 (could be expanded in future)
    const knownGiftCardPaymentIds = [
      // Add any known gift card payment IDs here if needed
    ];
    
    // 2. Check catalog object IDs for known gift card items
    const knownGiftCardCatalogIds = [
      // Square uses specific formats for gift card catalog IDs
      'GIFT_CARD'
    ];
    
    // 3. Check transaction references in receipt/order/payment data
    const orderName = (payment.orderName || '').toLowerCase();
    const note = (payment.note || '').toLowerCase();
    const receiptNumber = (payment.receiptNumber || '').toLowerCase();
    const paymentNote = (payment.note || '').toLowerCase();
    
    // 4. Check for Square's internal gift card indicators
    let hasGiftCardItems = false;
    let hasGiftCardType = false;
    
    // 5. Check if there are itemizations with gift card references
    if (payment.itemizations && Array.isArray(payment.itemizations)) {
      hasGiftCardItems = payment.itemizations.some((item: any) => {
        const itemName = (item.name || '').toLowerCase();
        return itemName.includes('gift card') || 
               itemName.includes('gift certificate') ||
               (item.itemType && item.itemType === 'GIFT_CARD');
      });
    }
    
    // 6. Check for Square's gift card type markers
    if (payment.type && payment.type === 'GIFT_CARD') {
      hasGiftCardType = true;
    }
    
    // 7. If the order has gift card details as part of the payment
    const hasGiftCardDetails = payment.orderInfo && 
      payment.orderInfo.giftCardInfo && 
      payment.orderInfo.giftCardInfo.length > 0;
      
    // 8. Look for "buy gift card" or similar phrases
    const hasBuyGiftCardPhrase = 
      orderName.includes('buy gift card') || 
      note.includes('buy gift card') ||
      orderName.includes('purchase gift card') || 
      note.includes('purchase gift card') ||
      orderName.includes('gift card purchase') || 
      note.includes('gift card purchase');
      
    // 9. Check for any partial gift card phrases (broader search)
    const hasGiftCardPhrase = 
      orderName.includes('gift card') || 
      orderName.includes('gift certificate') ||
      note.includes('gift card') || 
      note.includes('gift certificate') ||
      (receiptNumber && receiptNumber.includes('gift')) ||
      (paymentNote && paymentNote.includes('gift'));
    
    // 10. COMBINE ALL DETECTION METHODS to determine if this is likely a gift card purchase
    const isLikelyGiftCardPurchase = 
      knownGiftCardPaymentIds.includes(paymentId) ||
      hasGiftCardItems || 
      hasGiftCardType || 
      hasGiftCardDetails ||
      hasBuyGiftCardPhrase ||
      hasGiftCardPhrase;
    
    // Log detailed gift card detection for specific dates of interest
    const paymentDate = new Date(payment.createdAt || new Date());
    const isFeb25 = 
      paymentDate.getDate() === 25 && 
      paymentDate.getMonth() === 1 && // 0-indexed (February)
      paymentDate.getFullYear() === 2025;
    
    if (isFeb25 && (isLikelyGiftCardPurchase || hasGiftCardPhrase)) {
      console.log(`🔍 FEB 25 GIFT CARD DETECTION - Payment ID: ${paymentId}`);
      console.log(`💰 Amount: $${amount}`);
      console.log(`📝 Order name: ${orderName}`);
      console.log(`📝 Note: ${note}`);
      console.log(`Gift card detection result: ${isLikelyGiftCardPurchase ? 'POSITIVE ✅' : 'NEGATIVE ❌'}`);
    }
    
    if (isLikelyGiftCardPurchase) {
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
  
  // Safely parse the timestamp
  let timestamp: Date;
  try {
    timestamp = new Date(payment.createdAt);
    // Validate the date
    if (isNaN(timestamp.getTime())) {
      // If invalid, use current date
      console.warn(`Invalid timestamp for payment ${payment.id}, using current date instead`);
      timestamp = new Date();
    }
  } catch (error) {
    console.warn(`Error parsing timestamp for payment ${payment.id}, using current date instead:`, error);
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
  // Safely parse the purchase date
  let purchaseDate: Date;
  try {
    purchaseDate = new Date(giftCard.created_at);
    // Validate the date
    if (isNaN(purchaseDate.getTime())) {
      // If invalid, use current date
      console.warn(`Invalid purchase date for gift card ${giftCard.id}, using current date instead`);
      purchaseDate = new Date();
    }
  } catch (error) {
    console.warn(`Error parsing purchase date for gift card ${giftCard.id}, using current date instead:`, error);
    purchaseDate = new Date();
  }
  
  // Convert gift card data to handle BigInt values
  let cleanedGiftCardData: Record<string, any> = {};
  try {
    // Try the JSON parse/stringify approach with replacer
    cleanedGiftCardData = JSON.parse(JSON.stringify(giftCard, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value
    ));
  } catch (error) {
    console.warn(`Error stringifying gift card ${giftCard.id}, using manual conversion:`, error);
    // Manual fallback - create a new object without BigInt values
    Object.keys(giftCard).forEach(key => {
      const value = (giftCard as Record<string, any>)[key];
      if (typeof value === 'bigint') {
        cleanedGiftCardData[key] = value.toString();
      } else if (typeof value === 'object' && value !== null) {
        // For nested objects, we'll just store a simplified version
        try {
          cleanedGiftCardData[key] = JSON.stringify(value);
        } catch (e) {
          cleanedGiftCardData[key] = '[Complex Object]';
        }
      } else {
        cleanedGiftCardData[key] = value;
      }
    });
  }
  
  // Handle amount safely for potential BigInt values
  let amount = 0;
  if (giftCard.balance_money && giftCard.balance_money.amount !== undefined) {
    // Check if it's a BigInt and convert appropriately
    if (typeof giftCard.balance_money.amount === 'bigint') {
      amount = Number(giftCard.balance_money.amount) / 100;
    } else {
      // Regular number conversion
      amount = (Number(giftCard.balance_money.amount) || 0) / 100;
    }
  }
  
  const card: InsertGiftCard = {
    squareId: giftCard.id,
    amount: amount,
    redeemedAmount: 0, // May need to calculate this separately
    isActive: giftCard.state === 'ACTIVE',
    purchaseDate,
    squareData: cleanedGiftCardData
  };
  
  return card;
}

// Fetch gift cards from Square API
export async function fetchGiftCards(): Promise<any[]> {
  try {
    // Implement pagination to get ALL gift cards
    let allGiftCards: any[] = [];
    let cursor: string | undefined = undefined;
    let hasMorePages = true;
    let pageCount = 0;
    
    // Loop until we've fetched all pages
    while (hasMorePages) {
      pageCount++;
      console.log(`Fetching gift cards page ${pageCount}${cursor ? ' with cursor' : ''}`);
      
      // For v29.0.0, use the giftCardsApi with pagination
      try {
        // According to the Square API SDK:
        // listGiftCards(type?: string, state?: string, limit?: number, cursor?: string, customerId?: string)
        const response = await squareClient.giftCardsApi.listGiftCards(
          undefined,  // type 
          undefined,  // state
          100,        // limit - use a reasonable limit
          cursor,     // cursor
          undefined   // customerId
        );
        
        // Extract gift cards from the response
        const giftCards = response.result.giftCards || [];
        allGiftCards = [...allGiftCards, ...giftCards];
        
        // Check if there are more pages
        cursor = response.result.cursor;
        hasMorePages = !!cursor;
        
        console.log(`Fetched ${giftCards.length} gift cards on page ${pageCount}. Total so far: ${allGiftCards.length}`);
        
        // Add a small delay to avoid rate limiting
        if (hasMorePages) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error('Error fetching gift cards page:', error);
        // If we get an error, break the loop but return what we have so far
        hasMorePages = false;
      }
    }
    
    console.log(`Completed fetching ${allGiftCards.length} total gift cards from Square`);
    return allGiftCards;
  } catch (error) {
    console.error('Error fetching gift cards from Square:', error);
    // Log the detailed error if it's an object
    if (error && typeof error === 'object') {
      console.error('Detailed error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    }
    return [];
  }
}

export { squareClient };