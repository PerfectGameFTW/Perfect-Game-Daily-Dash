/**
 * Square API Sync Service
 * 
 * Handles synchronization of data between Square API and local database
 * Provides a clean and maintainable approach to data syncing
 */
import { 
  Order, InsertOrder, Payment, InsertPayment, GiftCard, InsertGiftCard,
  PaymentSource, InsertPaymentSource, SyncState, InsertSyncState
} from '../schema';
import { IStorage } from '../storage';

// Square client interface
export interface ISquareClient {
  fetchOrders(startDate?: Date, endDate?: Date): Promise<any[]>;
  fetchPayments(startDate?: Date, endDate?: Date): Promise<any[]>;
  fetchGiftCards(): Promise<any[]>;
  convertSquareOrderToOrder(squareOrder: any): InsertOrder;
  convertSquarePaymentToTransaction(payment: any): InsertPayment;
  convertSquareGiftCardToGiftCard(giftCard: any): InsertGiftCard;
  isGiftCardRedemption(payment: any): boolean;
}

export class SyncError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'SyncError';
  }
}

export class SyncService {
  constructor(
    private storage: IStorage,
    private squareClient: ISquareClient
  ) {}

  /**
   * Sync orders from Square API
   */
  async syncOrders(startDate?: Date, endDate?: Date): Promise<{
    success: boolean;
    ordersProcessed: number;
    message: string;
  }> {
    try {
      // Get or create sync state
      let syncState = await this.storage.getSyncState('orders');
      
      if (!syncState) {
        syncState = await this.storage.createSyncState({
          syncType: 'orders',
          lastSyncedAt: new Date(),
          isComplete: false,
          status: 'pending'
        });
      }
      
      // Update sync state to in-progress
      await this.storage.updateSyncState(syncState.id, {
        status: 'in_progress',
        lastSyncedAt: new Date()
      });
      
      // Fetch orders from Square
      console.log('Fetching orders from Square API...');
      const squareOrders = await this.squareClient.fetchOrders(startDate, endDate);
      console.log(`Fetched ${squareOrders.length} orders from Square API`);
      
      // Update sync state with total count
      await this.storage.updateSyncState(syncState.id, {
        totalCount: squareOrders.length,
        processedCount: 0
      });
      
      // Process each order
      let processedCount = 0;
      
      for (const squareOrder of squareOrders) {
        try {
          // Check if order already exists
          const existingOrder = await this.storage.getOrderBySquareId(squareOrder.id);
          
          if (existingOrder) {
            // Skip existing orders
            console.log(`Order ${squareOrder.id} already exists, skipping`);
            processedCount++;
            continue;
          }
          
          // Convert Square order to local format
          const orderData = this.squareClient.convertSquareOrderToOrder(squareOrder);
          
          // Create order in database
          const createdOrder = await this.storage.createOrder(orderData);
          
          // Process line items, modifiers, discounts
          if (squareOrder.lineItems) {
            for (const lineItem of squareOrder.lineItems) {
              // TODO: Implement line item processing
            }
          }
          
          processedCount++;
          
          // Update sync state periodically
          if (processedCount % 10 === 0) {
            await this.storage.updateSyncState(syncState.id, {
              processedCount,
              lastSyncedAt: new Date()
            });
          }
        } catch (error) {
          console.error(`Error processing order ${squareOrder.id}:`, error);
          // Continue with next order
        }
      }
      
      // Update sync state to complete
      await this.storage.updateSyncState(syncState.id, {
        processedCount,
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date()
      });
      
      return {
        success: true,
        ordersProcessed: processedCount,
        message: `Successfully processed ${processedCount} orders`
      };
    } catch (error) {
      console.error('Error syncing orders:', error);
      
      // Update sync state to failed
      try {
        const syncState = await this.storage.getSyncState('orders');
        
        if (syncState) {
          await this.storage.updateSyncState(syncState.id, {
            status: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            lastSyncedAt: new Date()
          });
        }
      } catch (updateError) {
        console.error('Error updating sync state:', updateError);
      }
      
      throw new SyncError(
        'Failed to sync orders',
        'SYNC_ORDERS_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  
  /**
   * Sync payments from Square API
   */
  async syncPayments(startDate?: Date, endDate?: Date): Promise<{
    success: boolean;
    paymentsProcessed: number;
    message: string;
  }> {
    try {
      // Get or create sync state
      let syncState = await this.storage.getSyncState('payments');
      
      if (!syncState) {
        syncState = await this.storage.createSyncState({
          syncType: 'payments',
          lastSyncedAt: new Date(),
          isComplete: false,
          status: 'pending'
        });
      }
      
      // Update sync state to in-progress
      await this.storage.updateSyncState(syncState.id, {
        status: 'in_progress',
        lastSyncedAt: new Date()
      });
      
      // Fetch payments from Square
      console.log('Fetching payments from Square API...');
      const squarePayments = await this.squareClient.fetchPayments(startDate, endDate);
      console.log(`Fetched ${squarePayments.length} payments from Square API`);
      
      // Update sync state with total count
      await this.storage.updateSyncState(syncState.id, {
        totalCount: squarePayments.length,
        processedCount: 0
      });
      
      // Process each payment
      let processedCount = 0;
      
      for (const squarePayment of squarePayments) {
        try {
          // Check if payment already exists
          const existingPayment = await this.storage.getPaymentBySquareId(squarePayment.id);
          
          if (existingPayment) {
            // Skip existing payments
            console.log(`Payment ${squarePayment.id} already exists, skipping`);
            processedCount++;
            continue;
          }
          
          // Convert Square payment to local format
          const paymentData = this.squareClient.convertSquarePaymentToTransaction(squarePayment);
          
          // Check if this is a gift card redemption
          const isGiftCardRedemption = this.squareClient.isGiftCardRedemption(squarePayment);
          
          // Create payment source if needed
          let sourceId: number | undefined;
          
          if (squarePayment.cardDetails?.card?.id) {
            const existingSource = await this.storage.getPaymentSourceBySquareId(
              squarePayment.cardDetails.card.id
            );
            
            if (existingSource) {
              sourceId = existingSource.id;
            } else {
              // Create payment source
              const sourceData: InsertPaymentSource = {
                squareId: squarePayment.cardDetails.card.id,
                type: squarePayment.cardDetails.card.cardBrand || 'UNKNOWN',
                brand: squarePayment.cardDetails.card.cardBrand || 'UNKNOWN',
                last4: squarePayment.cardDetails.card.last4 || undefined,
                giftCardId: undefined, // Will be set later if this is a gift card
                metadata: {}
              };
              
              const createdSource = await this.storage.createPaymentSource(sourceData);
              sourceId = createdSource.id;
            }
          }
          
          // Create payment
          const createdPayment = await this.storage.createPayment({
            ...paymentData,
            sourceId
          });
          
          // Handle gift card redemption if applicable
          if (isGiftCardRedemption && squarePayment.cardDetails?.card?.id) {
            // Check if gift card exists
            const giftCard = await this.storage.getGiftCardBySquareId(
              squarePayment.cardDetails.card.id
            );
            
            if (giftCard) {
              // Create redemption record
              await this.storage.createGiftCardRedemption({
                giftCardId: giftCard.id,
                paymentId: createdPayment.id,
                orderId: createdPayment.orderId,
                amount: createdPayment.amount,
                timestamp: createdPayment.timestamp,
                squareData: squarePayment
              });
              
              // Update gift card balance
              await this.storage.updateGiftCard(giftCard.id, {
                currentBalance: Math.max(0, giftCard.currentBalance - createdPayment.amount),
                redeemedAmount: giftCard.redeemedAmount + createdPayment.amount
              });
            }
          }
          
          processedCount++;
          
          // Update sync state periodically
          if (processedCount % 10 === 0) {
            await this.storage.updateSyncState(syncState.id, {
              processedCount,
              lastSyncedAt: new Date()
            });
          }
        } catch (error) {
          console.error(`Error processing payment ${squarePayment.id}:`, error);
          // Continue with next payment
        }
      }
      
      // Update sync state to complete
      await this.storage.updateSyncState(syncState.id, {
        processedCount,
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date()
      });
      
      return {
        success: true,
        paymentsProcessed: processedCount,
        message: `Successfully processed ${processedCount} payments`
      };
    } catch (error) {
      console.error('Error syncing payments:', error);
      
      // Update sync state to failed
      try {
        const syncState = await this.storage.getSyncState('payments');
        
        if (syncState) {
          await this.storage.updateSyncState(syncState.id, {
            status: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            lastSyncedAt: new Date()
          });
        }
      } catch (updateError) {
        console.error('Error updating sync state:', updateError);
      }
      
      throw new SyncError(
        'Failed to sync payments',
        'SYNC_PAYMENTS_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  
  /**
   * Sync gift cards from Square API
   */
  async syncGiftCards(): Promise<{
    success: boolean;
    giftCardsProcessed: number;
    message: string;
  }> {
    try {
      // Get or create sync state
      let syncState = await this.storage.getSyncState('gift_cards');
      
      if (!syncState) {
        syncState = await this.storage.createSyncState({
          syncType: 'gift_cards',
          lastSyncedAt: new Date(),
          isComplete: false,
          status: 'pending'
        });
      }
      
      // Update sync state to in-progress
      await this.storage.updateSyncState(syncState.id, {
        status: 'in_progress',
        lastSyncedAt: new Date()
      });
      
      // Fetch gift cards from Square
      console.log('Fetching gift cards from Square API...');
      const squareGiftCards = await this.squareClient.fetchGiftCards();
      console.log(`Fetched ${squareGiftCards.length} gift cards from Square API`);
      
      // Update sync state with total count
      await this.storage.updateSyncState(syncState.id, {
        totalCount: squareGiftCards.length,
        processedCount: 0
      });
      
      // Process each gift card
      let processedCount = 0;
      
      for (const squareGiftCard of squareGiftCards) {
        try {
          // Check if gift card already exists
          const existingGiftCard = await this.storage.getGiftCardBySquareId(squareGiftCard.id);
          
          if (existingGiftCard) {
            // Update existing gift card
            console.log(`Updating gift card ${squareGiftCard.id}`);
            
            const giftCardData = this.squareClient.convertSquareGiftCardToGiftCard(squareGiftCard);
            
            await this.storage.updateGiftCard(existingGiftCard.id, {
              currentBalance: giftCardData.currentBalance,
              isActive: giftCardData.isActive,
              squareData: giftCardData.squareData
            });
            
            processedCount++;
            continue;
          }
          
          // Convert Square gift card to local format
          const giftCardData = this.squareClient.convertSquareGiftCardToGiftCard(squareGiftCard);
          
          // Create gift card
          const createdGiftCard = await this.storage.createGiftCard(giftCardData);
          
          processedCount++;
          
          // Update sync state periodically
          if (processedCount % 10 === 0) {
            await this.storage.updateSyncState(syncState.id, {
              processedCount,
              lastSyncedAt: new Date()
            });
          }
        } catch (error) {
          console.error(`Error processing gift card ${squareGiftCard.id}:`, error);
          // Continue with next gift card
        }
      }
      
      // Update sync state to complete
      await this.storage.updateSyncState(syncState.id, {
        processedCount,
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date()
      });
      
      return {
        success: true,
        giftCardsProcessed: processedCount,
        message: `Successfully processed ${processedCount} gift cards`
      };
    } catch (error) {
      console.error('Error syncing gift cards:', error);
      
      // Update sync state to failed
      try {
        const syncState = await this.storage.getSyncState('gift_cards');
        
        if (syncState) {
          await this.storage.updateSyncState(syncState.id, {
            status: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            lastSyncedAt: new Date()
          });
        }
      } catch (updateError) {
        console.error('Error updating sync state:', updateError);
      }
      
      throw new SyncError(
        'Failed to sync gift cards',
        'SYNC_GIFT_CARDS_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  
  /**
   * Update gift card activation amounts from orders
   * This is a maintenance function to ensure gift card amounts are correct
   */
  async updateGiftCardActivationAmounts(): Promise<{
    success: boolean;
    updatedCount: number;
    message: string;
  }> {
    try {
      console.log('Starting gift card activation amount update...');
      
      // Get all gift cards
      const allGiftCards = await this.storage.listGiftCards();
      console.log(`Found ${allGiftCards.length} gift cards to check`);
      
      let updatedCount = 0;
      
      for (const giftCard of allGiftCards) {
        try {
          // Skip cards that already have activation amounts
          if (giftCard.activationAmount > 0) {
            continue;
          }
          
          // Find payment that created this gift card
          const activationPayment = await this.findGiftCardActivationPayment(giftCard);
          
          if (activationPayment) {
            // Update gift card with activation amount
            await this.storage.updateGiftCard(giftCard.id, {
              activationAmount: activationPayment.amount,
              activationPaymentId: activationPayment.id
            });
            
            updatedCount++;
          }
        } catch (cardError) {
          console.error(`Error updating gift card ${giftCard.id}:`, cardError);
          // Continue with next card
        }
      }
      
      return {
        success: true,
        updatedCount,
        message: `Successfully updated ${updatedCount} gift cards`
      };
    } catch (error) {
      console.error('Error updating gift card activation amounts:', error);
      
      throw new SyncError(
        'Failed to update gift card activation amounts',
        'UPDATE_GIFT_CARD_AMOUNTS_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  
  /**
   * Helper method to find the activation payment for a gift card
   */
  private async findGiftCardActivationPayment(giftCard: GiftCard): Promise<Payment | undefined> {
    // Method 1: Check for payment with matching gift card ID
    const paymentsWithGiftCardId = await this.db.execute(sql`
      SELECT * FROM payments
      WHERE gift_card_id = ${giftCard.id}
      AND is_gift_card_activation = true
      LIMIT 1
    `);
    
    if (paymentsWithGiftCardId.rows.length > 0) {
      return paymentsWithGiftCardId.rows[0];
    }
    
    // Method 2: Check for payment with matching timestamp (within 1 minute)
    const paymentsNearCreation = await this.db.execute(sql`
      SELECT * FROM payments
      WHERE is_gift_card_activation = true
      AND ABS(EXTRACT(EPOCH FROM (timestamp - ${giftCard.createdAt}))) < 60
      ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - ${giftCard.createdAt})))
      LIMIT 1
    `);
    
    if (paymentsNearCreation.rows.length > 0) {
      return paymentsNearCreation.rows[0];
    }
    
    // Method 3: Check for order line items containing gift cards
    if (giftCard.gan) {
      const ordersWithGiftCards = await this.db.execute(sql`
        SELECT o.*, oli.*
        FROM orders o
        JOIN order_line_items oli ON o.id = oli.order_id
        WHERE oli.is_gift_card = true
        AND o.square_data::text LIKE ${'%' + giftCard.gan + '%'}
        LIMIT 1
      `);
      
      if (ordersWithGiftCards.rows.length > 0) {
        const order = ordersWithGiftCards.rows[0];
        
        // Find payment for this order
        const paymentForOrder = await this.db.execute(sql`
          SELECT * FROM payments
          WHERE order_id = ${order.id}
          OR square_order_id = ${order.square_id}
          LIMIT 1
        `);
        
        if (paymentForOrder.rows.length > 0) {
          return paymentForOrder.rows[0];
        }
      }
    }
    
    return undefined;
  }
}