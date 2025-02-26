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
      }
    };
    
    // Make API request to Square Orders API
    const response = await squareClient.ordersApi.searchOrders(searchRequest);
    
    // Extract orders from the SearchOrdersResponse
    const orders = response.result.orders || [];
    return orders;
  } catch (error) {
    console.error('Error fetching orders from Square:', error);
    return [];
  }
}

// Fetch payments from Square API
export async function fetchPayments(startDate?: Date, endDate?: Date): Promise<any[]> {
  try {
    // In Square API 29.0.0, we need to use a different approach
    // First try without dates to get default recent payments
    const response = await squareClient.paymentsApi.listPayments();
    
    // Extract payments from the response
    const payments = response.result.payments || [];
    console.log(`Fetched ${payments.length} payments from Square`);
    return payments;
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
  const amount = amountMoney ? (amountMoney.amount || 0) / 100 : 0; // Convert from cents to dollars
  
  // Determine category based on payment information
  let category: Category = 'retail'; // Default
  
  // If there's order data, try to determine a more specific category
  if (payment.orderId) {
    // This is a simplification - in real implementation, 
    // you would fetch the order details and analyze line items
    category = payment.orderName ? mapSquareCategory(payment.orderName) : 'retail';
  } else if (payment.note) {
    category = mapSquareCategory(payment.note);
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
  let cleanedPaymentData;
  try {
    // Try the JSON parse/stringify approach with replacer
    cleanedPaymentData = JSON.parse(JSON.stringify(payment, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value
    ));
  } catch (error) {
    console.warn(`Error stringifying payment ${payment.id}, using manual conversion:`, error);
    // Manual fallback - create a new object without BigInt values
    cleanedPaymentData = {};
    for (const key in payment) {
      if (Object.prototype.hasOwnProperty.call(payment, key)) {
        const value = payment[key];
        if (typeof value === 'bigint') {
          cleanedPaymentData[key] = value.toString();
        } else if (typeof value === 'object' && value !== null) {
          // For nested objects, we'll just store a simplified version
          cleanedPaymentData[key] = `[Object: ${JSON.stringify(value)}]`;
        } else {
          cleanedPaymentData[key] = value;
        }
      }
    }
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
  
  // Convert any BigInt values in the gift card data to strings
  const cleanedGiftCardData = JSON.parse(JSON.stringify(giftCard, (key, value) => 
    typeof value === 'bigint' ? value.toString() : value
  ));
  
  const card: InsertGiftCard = {
    squareId: giftCard.id,
    amount: giftCard.balance_money ? (giftCard.balance_money.amount || 0) / 100 : 0,
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
    // For v29.0.0, use the giftCardsApi
    const response = await squareClient.giftCardsApi.listGiftCards();
    
    // Extract gift cards from the response
    const giftCards = response.result.giftCards || [];
    console.log(`Fetched ${giftCards.length} gift cards from Square`);
    return giftCards;
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