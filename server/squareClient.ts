import { SquareClient, SquareEnvironment } from 'square';
import { 
  Transaction, InsertTransaction,
  GiftCard, InsertGiftCard,
  Category, TransactionStatus
} from '@shared/schema';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Square client
const squareClient = new SquareClient({
  accessToken: process.env.SQUARE_ACCESS_TOKEN || '',
  environment: process.env.NODE_ENV === 'production' 
    ? SquareEnvironment.Production 
    : SquareEnvironment.Sandbox
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
    
    // Make API request to Square Orders API
    const response = await squareClient.ordersApi.search({
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
    });
    
    return response.result.orders || [];
  } catch (error) {
    console.error('Error fetching orders from Square:', error);
    return [];
  }
}

// Fetch payments from Square API
export async function fetchPayments(startDate?: Date, endDate?: Date): Promise<any[]> {
  try {
    const now = new Date();
    const start = startDate || new Date(now.setDate(now.getDate() - 30));
    const end = endDate || new Date();
    
    // Format dates for Square API
    const startTime = start.toISOString();
    const endTime = end.toISOString();
    
    // Make API request to Square Payments API
    const response = await squareClient.paymentsApi.listPayments({
      beginTime: startTime,
      endTime: endTime,
      locationId: process.env.SQUARE_LOCATION_ID,
      limit: 100
    });
    
    return response.result.payments || [];
  } catch (error) {
    console.error('Error fetching payments from Square:', error);
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
  
  // Map to our transaction model
  const transaction: InsertTransaction = {
    squareId: payment.id,
    amount,
    categoryId: category,
    status: mapSquareStatus(payment.status),
    timestamp: new Date(payment.createdAt),
    squareData: payment
  };
  
  return transaction;
}

// Convert Square gift card to our GiftCard model
export function convertSquareGiftCardToGiftCard(giftCard: Record<string, any>): InsertGiftCard {
  const card: InsertGiftCard = {
    squareId: giftCard.id,
    amount: giftCard.balance_money ? (giftCard.balance_money.amount || 0) / 100 : 0,
    redeemedAmount: 0, // May need to calculate this separately
    isActive: giftCard.state === 'ACTIVE',
    purchaseDate: new Date(giftCard.created_at),
    squareData: giftCard
  };
  
  return card;
}

// Fetch gift cards from Square API
export async function fetchGiftCards(): Promise<any[]> {
  try {
    const response = await squareClient.giftCardsApi.listGiftCards({
      type: 'DIGITAL' // You can change this based on your requirements
    });
    return response.result.giftCards || [];
  } catch (error) {
    console.error('Error fetching gift cards from Square:', error);
    return [];
  }
}

export { squareClient };