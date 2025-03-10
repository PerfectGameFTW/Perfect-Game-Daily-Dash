/**
 * Sync Service
 * 
 * Handles synchronization of data with the Square API.
 * Provides a clean API for other services to trigger synchronization.
 * 
 * NOTE: This version includes important fixes to prevent infinite loops and handle timeouts.
 */

import { db } from '../db';
import { eq, and, between, desc, asc, sql, isNull, gt } from 'drizzle-orm';
import { 
  syncState,
  type SyncState,
  type InsertSyncState
} from '../../shared/schema';
import * as squareClient from '../squareClient';
import { orderService } from './orderService';
import { paymentService } from './paymentService';
import { giftCardService } from './giftCardService';

export class SyncError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'SyncError';
  }
}

export class SyncService {
  /**
   * Get the current sync state for a specific sync type
   * 
   * @param syncType The type of sync to get state for (payments, orders, giftCards)
   * @returns The sync state or undefined if not found
   */
  async getSyncState(syncType: string): Promise<SyncState | undefined> {
    const result = await db.select().from(syncState)
      .where(eq(syncState.syncType, syncType))
      .limit(1);
    
    return result.length ? result[0] : undefined;
  }
  
  /**
   * Create a new sync state record
   * 
   * @param stateData The sync state data to insert
   * @returns The created sync state
   */
  async createSyncState(stateData: InsertSyncState): Promise<SyncState> {
    const result = await db.insert(syncState).values(stateData).returning();
    
    if (!result.length) {
      throw new SyncError('Failed to create sync state', 'DB_ERROR');
    }
    
    return result[0];
  }
  
  /**
   * Update an existing sync state record
   * 
   * @param id The sync state ID
   * @param updates The partial sync state data to update
   * @returns The updated sync state
   */
  async updateSyncState(id: number, updates: Partial<InsertSyncState>): Promise<SyncState> {
    const result = await db.update(syncState)
      .set({
        ...updates
        // Note: There's no updatedAt field in the syncState schema
      })
      .where(eq(syncState.id, id))
      .returning();
    
    if (!result.length) {
      throw new SyncError(`Failed to update sync state with ID ${id}`, 'DB_ERROR');
    }
    
    return result[0];
  }
  
  /**
   * Get the current sync progress for all sync types
   * 
   * @returns Object with sync progress for each type
   */
  async getSyncProgress(): Promise<Record<string, number>> {
    const states = await db.select().from(syncState);
    
    const progress: Record<string, number> = {};
    
    for (const state of states) {
      // Using totalCount and processedCount from the schema
      const totalCount = state.totalCount || 0;
      const processedCount = state.processedCount || 0;
      
      if (totalCount > 0) {
        progress[state.syncType] = Math.min(
          100,
          Math.round((processedCount / totalCount) * 100)
        );
      } else {
        progress[state.syncType] = 0;
      }
    }
    
    return progress;
  }
  
  /**
   * Synchronize gift card redemptions from historical transactions
   * This method scans past transactions to find gift card redemptions and records them
   * 
   * @param startDate Optional start date for the sync
   * @param endDate Optional end date for the sync
   * @returns Object with sync results
   */
  async syncGiftCardRedemptions(startDate?: Date, endDate?: Date): Promise<{
    success: boolean;
    processed: number;
    matched: number;
    created: number;
    errors: any[];
  }> {
    console.log(`Starting gift card redemption sync from ${startDate?.toISOString() || 'beginning'} to ${endDate?.toISOString() || 'now'}`);
    
    try {
      // Set default dates if not provided
      const effectiveStartDate = startDate || new Date('2025-01-01');
      const effectiveEndDate = endDate || new Date();
      
      // Step 1: Get all transactions that could be gift card redemptions
      const query = sql`
        SELECT t.* 
        FROM transactions t
        WHERE t.status = 'completed'
          AND t.timestamp BETWEEN ${effectiveStartDate} AND ${effectiveEndDate}
          AND (t.square_data->>'isGiftCardRedemption')::boolean IS TRUE
          AND NOT EXISTS (
            SELECT 1 FROM gift_card_redemptions gcr
            WHERE gcr.transaction_id = t.id
          )
      `;
      
      const transactions = await db.execute(query);
      
      console.log(`Found ${transactions.rowCount} potential gift card redemptions to process`);
      
      // Initialize result counters
      const result = {
        success: true,
        processed: 0,
        matched: 0,
        created: 0,
        errors: [] as any[]
      };
      
      // Step 2: Process each transaction
      if (transactions.rows && transactions.rows.length > 0) {
        for (const transaction of transactions.rows) {
          try {
            result.processed++;
            
            // Extract gift card ID (GAN) from Square data
            const squareData = transaction.square_data || {};
            // Safely access sourceId with type checking
            const squareDataObj = typeof squareData === 'object' && squareData !== null ? squareData : {};
            // TypeScript: Cast to any to avoid property access errors on unknown type
            const sourceId = (squareDataObj as any).sourceId || '';
            
            if (!sourceId) {
              result.errors.push({
                transactionId: transaction.id,
                error: 'No sourceId (GAN) found in transaction data'
              });
              continue;
            }
            
            // Process the redemption
            // Ensure transaction.id is a number
            const transactionId = typeof transaction.id === 'number' 
              ? transaction.id 
              : (transaction.id ? parseInt(String(transaction.id), 10) : 0);
              
            // Explicitly type the transaction.amount from unknown to number
            // Using type assertion after validation to ensure it's safe
            let amount = 0;
            if (transaction && 'amount' in transaction) {
              if (typeof transaction.amount === 'number') {
                amount = transaction.amount;
              } else if (transaction.amount !== undefined && transaction.amount !== null) {
                // Convert string/unknown to number if possible
                const parsedAmount = parseFloat(String(transaction.amount));
                if (!isNaN(parsedAmount)) {
                  amount = parsedAmount;
                }
              }
            }
              
            const redemptionResult = await giftCardService.processRedemptionFromSquare(
              sourceId,
              amount,
              transactionId,
              squareData
            );
            
            if (redemptionResult) {
              result.matched++;
              result.created++;
              console.log(`Created redemption record for transaction ${transaction.id}, gift card ${redemptionResult.id} (${redemptionResult.gan || sourceId})`);
            } else {
              result.errors.push({
                transactionId: transaction.id,
                sourceId,
                error: 'Could not find matching gift card'
              });
            }
          } catch (error) {
            console.error(`Error processing transaction ${transaction.id}:`, error);
            result.errors.push({
              transactionId: transaction.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
      
      // Step 3: Update sync state
      try {
        const syncState = await this.getSyncState('gift_card_redemptions');
        
        if (syncState) {
          await this.updateSyncState(syncState.id, {
            lastSyncedAt: new Date(),
            processedCount: result.created,
            status: 'completed',
            errorMessage: result.errors.length > 0 ? JSON.stringify(result.errors) : undefined
          });
        } else {
          await this.createSyncState({
            syncType: 'gift_card_redemptions',
            lastSyncedAt: new Date(),
            processedCount: result.created,
            status: 'completed',
            errorMessage: result.errors.length > 0 ? JSON.stringify(result.errors) : undefined
          });
        }
      } catch (syncError) {
        console.error('Failed to update sync state:', syncError);
      }
      
      return result;
    } catch (error) {
      console.error('Error synchronizing gift card redemptions:', error);
      return {
        success: false,
        processed: 0,
        matched: 0,
        created: 0,
        errors: [{
          error: error instanceof Error ? error.message : String(error)
        }]
      };
    }
  }
  
  /**
   * Synchronize orders from Square API
   * 
   * @param startDate Optional start date for sync
   * @param endDate Optional end date for sync
   * @returns Object with sync results
   */
  async syncOrders(startDate?: Date, endDate?: Date): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    alreadyRunning?: boolean;
  }> {
    // Initialize counters
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;
    
    try {
      // Get or create sync state
      let state = await this.getSyncState('orders');
      
      // Check if a sync is already in progress and prevent duplicate runs
      if (state && state.status === 'in_progress') {
        const lastSyncTime = state.lastSyncedAt ? new Date(state.lastSyncedAt) : new Date(0);
        const currentTime = new Date();
        const timeDifference = currentTime.getTime() - lastSyncTime.getTime();
        const timeThreshold = 30 * 60 * 1000; // 30 minutes in milliseconds
        
        // If the last sync started less than 30 minutes ago and is still marked as in_progress,
        // we consider it potentially stuck
        if (timeDifference < timeThreshold) {
          console.log(`Sync for orders already in progress. Started at ${lastSyncTime.toISOString()}`);
          return { 
            processed: state.processedCount || 0, 
            created, 
            updated, 
            failed, 
            alreadyRunning: true 
          };
        } else {
          // If it's been running for more than 30 minutes, we'll assume it's stuck and restart it
          console.log(`Previous orders sync appears to be stuck (running for ${Math.round(timeDifference/60000)} minutes). Restarting...`);
        }
      }
      
      if (!state) {
        state = await this.createSyncState({
          syncType: 'orders',
          lastSyncedAt: new Date(),
          isComplete: false,
          processedCount: 0,
          totalCount: 0,
          status: 'idle',
          errorMessage: null
        });
      }
      
      // Update state to in progress
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        lastSyncedAt: new Date(), // Update the timestamp to now
        processedCount: 0,
        totalCount: 0,
        errorMessage: null
      });
      
      // Fetch orders from Square API with a timeout
      const fetchPromise = squareClient.fetchOrders(startDate, endDate);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Order fetch timed out after 2 minutes')), 120000);
      });
      
      const squareOrders = await Promise.race([fetchPromise, timeoutPromise]) as any[];
      
      if (!squareOrders || !Array.isArray(squareOrders)) {
        throw new Error('Failed to fetch orders: Invalid response format');
      }
      
      // Set a reasonable limit to prevent processing too many orders at once
      const maxOrdersToProcess = 500; // Adjust as needed
      const ordersToProcess = squareOrders.slice(0, maxOrdersToProcess);
      
      // Update state with total items
      await this.updateSyncState(state.id, {
        totalCount: ordersToProcess.length,
        status: `Found ${ordersToProcess.length} orders to sync${ordersToProcess.length < squareOrders.length ? ' (limited to prevent timeout)' : ''}`
      });
      
      // Process each order
      for (const squareOrder of ordersToProcess) {
        try {
          // Convert Square order to our data model
          const orderData = squareClient.convertSquareOrderToOrder(squareOrder);
          
          // Check if order exists
          let existingOrder: any = null;
          try {
            existingOrder = await orderService.getOrderBySquareId(orderData.squareId);
          } catch (error) {
            // Order doesn't exist, which is fine
          }
          
          if (existingOrder && typeof existingOrder === 'object' && existingOrder !== null) {
            // Order exists, skip for now (could implement update logic here)
            updated++;
          } else {
            // Order doesn't exist, create it
            const createdOrder = await orderService.createOrder(orderData);
            
            // Extract and create line items
            if (squareOrder.lineItems) {
              for (const squareLineItem of squareOrder.lineItems) {
                // Safely extract order ID with fallback
                let orderId = 0;
                
                // Type safe way to access order ID
                if (existingOrder && typeof existingOrder === 'object' && existingOrder !== null && 'id' in existingOrder) {
                  // existingOrder is an Order type from getOrderBySquareId
                  orderId = Number(existingOrder.id);
                } else if (createdOrder && typeof createdOrder === 'object' && createdOrder !== null && 'id' in createdOrder) {
                  // createdOrder is from createOrder which returns an Order
                  orderId = Number(createdOrder.id);
                }
                
                if (orderId === 0) {
                  console.warn('Could not determine order ID for line item, skipping');
                  continue;
                }
                
                const lineItemData = squareClient.convertSquareLineItemToOrderLineItem(
                  squareLineItem,
                  orderId
                );
                
                const lineItem = await orderService.createOrderItem(lineItemData);
                
                // Extract and create modifiers if any
                if (squareLineItem.modifiers && squareLineItem.modifiers.length > 0) {
                  for (const squareModifier of squareLineItem.modifiers) {
                    const modifierData = squareClient.convertSquareModifierToOrderModifier(
                      squareModifier,
                      lineItem.id
                    );
                    
                    // Create modifier (would need a createOrderModifier method)
                  }
                }
              }
            }
            
            // Extract and create discounts if any
            if (squareOrder.discounts) {
              for (const squareDiscount of squareOrder.discounts) {
                // Safely extract order ID with fallback
                let orderId = 0;
                
                // Type safe way to access order ID
                if (existingOrder && typeof existingOrder === 'object' && existingOrder !== null && 'id' in existingOrder) {
                  // existingOrder is an Order type from getOrderBySquareId
                  orderId = Number(existingOrder.id);
                } else if (createdOrder && typeof createdOrder === 'object' && createdOrder !== null && 'id' in createdOrder) {
                  // createdOrder is from createOrder which returns an Order
                  orderId = Number(createdOrder.id);
                }
                
                if (orderId === 0) {
                  console.warn('Could not determine order ID for discount, skipping');
                  continue;
                }
                
                const discountData = squareClient.convertSquareDiscountToOrderDiscount(
                  squareDiscount,
                  orderId
                );
                
                // Create discount (would need a createOrderDiscount method)
              }
            }
            
            created++;
          }
          
          processed++;
          
          // Update sync state progress
          if (processed % 10 === 0 || processed === ordersToProcess.length) {
            await this.updateSyncState(state.id, {
              processedCount: processed,
              status: `Processed ${processed} of ${ordersToProcess.length} orders`
            });
          }
        } catch (error) {
          failed++;
          console.error('Failed to process order:', error);
        }
      }
      
      // Update state to completed
      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date(),
        processedCount: processed
      });
      
      return { processed, created, updated, failed };
    } catch (error) {
      // Update state to error
      const state = await this.getSyncState('orders');
      
      if (state) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      
      throw new SyncError(
        'Failed to sync orders',
        'SYNC_ERROR',
        error instanceof Error ? error.message : error
      );
    }
  }
  
  /**
   * Synchronize payments from Square API
   * 
   * @param startDate Optional start date for sync
   * @param endDate Optional end date for sync
   * @returns Object with sync results
   */
  async syncPayments(startDate?: Date, endDate?: Date): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    alreadyRunning?: boolean;
  }> {
    // Initialize counters
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;
    
    try {
      // Get or create sync state
      let state = await this.getSyncState('payments');
      
      // Check if a sync is already in progress and prevent duplicate runs
      if (state && state.status === 'in_progress') {
        const lastSyncTime = state.lastSyncedAt ? new Date(state.lastSyncedAt) : new Date(0);
        const currentTime = new Date();
        const timeDifference = currentTime.getTime() - lastSyncTime.getTime();
        const timeThreshold = 30 * 60 * 1000; // 30 minutes in milliseconds
        
        // If the last sync started less than 30 minutes ago and is still marked as in_progress,
        // we consider it potentially stuck
        if (timeDifference < timeThreshold) {
          console.log(`Sync for payments already in progress. Started at ${lastSyncTime.toISOString()}`);
          return { 
            processed: state.processedCount || 0, 
            created, 
            updated, 
            failed, 
            alreadyRunning: true 
          };
        } else {
          // If it's been running for more than 30 minutes, we'll assume it's stuck and restart it
          console.log(`Previous payments sync appears to be stuck (running for ${Math.round(timeDifference/60000)} minutes). Restarting...`);
        }
      }
      
      if (!state) {
        state = await this.createSyncState({
          syncType: 'payments',
          lastSyncedAt: new Date(),
          isComplete: false,
          processedCount: 0,
          totalCount: 0,
          status: 'idle',
          errorMessage: null
        });
      }
      
      // Update state to in progress
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        processedCount: 0,
        totalCount: 0,
        errorMessage: null
      });
      
      // Fetch payments from Square API
      const squarePayments = await squareClient.fetchPayments(startDate, endDate);
      
      // Update state with total items
      await this.updateSyncState(state.id, {
        totalCount: squarePayments.length,
        status: `Found ${squarePayments.length} payments to sync`
      });
      
      // Process each payment
      for (const squarePayment of squarePayments) {
        try {
          // Convert Square payment to our data model
          const paymentData = squareClient.convertSquarePaymentToTransaction(squarePayment);
          
          // Check if payment exists
          let existingPayment;
          try {
            existingPayment = await paymentService.getPaymentBySquareId(paymentData.squareId);
          } catch (error) {
            // Payment doesn't exist, which is fine
          }
          
          if (existingPayment) {
            // Payment exists, skip for now (could implement update logic here)
            updated++;
          } else {
            // Payment doesn't exist, create it
            await paymentService.createPayment(paymentData);
            created++;
          }
          
          processed++;
          
          // Update sync state progress
          if (processed % 10 === 0 || processed === squarePayments.length) {
            await this.updateSyncState(state.id, {
              processedCount: processed,
              status: `Processed ${processed} of ${squarePayments.length} payments`
            });
          }
        } catch (error) {
          failed++;
          console.error('Failed to process payment:', error);
        }
      }
      
      // Update state to completed
      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date(),
        processedCount: processed
      });
      
      return { processed, created, updated, failed };
    } catch (error) {
      // Update state to error
      const state = await this.getSyncState('payments');
      
      if (state) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      
      throw new SyncError(
        'Failed to sync payments',
        'SYNC_ERROR',
        error instanceof Error ? error.message : error
      );
    }
  }
  
  /**
   * Synchronize gift cards from Square API
   * 
   * @returns Object with sync results
   */
  async syncGiftCards(): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    alreadyRunning?: boolean;
  }> {
    // Initialize counters
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;
    
    try {
      // Get or create sync state
      let state = await this.getSyncState('giftCards');
      
      // Check if a sync is already in progress and prevent duplicate runs
      if (state && state.status === 'in_progress') {
        const lastSyncTime = state.lastSyncedAt ? new Date(state.lastSyncedAt) : new Date(0);
        const currentTime = new Date();
        const timeDifference = currentTime.getTime() - lastSyncTime.getTime();
        const timeThreshold = 30 * 60 * 1000; // 30 minutes in milliseconds
        
        // If the last sync started less than 30 minutes ago and is still marked as in_progress,
        // we consider it potentially stuck
        if (timeDifference < timeThreshold) {
          console.log(`Sync for gift cards already in progress. Started at ${lastSyncTime.toISOString()}`);
          return { 
            processed: state.processedCount || 0, 
            created, 
            updated, 
            failed, 
            alreadyRunning: true 
          };
        } else {
          // If it's been running for more than 30 minutes, we'll assume it's stuck and restart it
          console.log(`Previous gift cards sync appears to be stuck (running for ${Math.round(timeDifference/60000)} minutes). Restarting...`);
        }
      }
      
      if (!state) {
        state = await this.createSyncState({
          syncType: 'giftCards',
          lastSyncedAt: new Date(),
          isComplete: false,
          processedCount: 0,
          totalCount: 0,
          status: 'idle',
          errorMessage: null
        });
      }
      
      // Update state to in progress
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        lastSyncedAt: new Date(), // Update the timestamp to now
        processedCount: 0,
        totalCount: 0,
        errorMessage: null
      });
      
      // Fetch gift cards from Square API with a timeout
      const fetchPromise = squareClient.fetchGiftCards();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Gift card fetch timed out after 2 minutes')), 120000);
      });
      
      const squareGiftCards = await Promise.race([fetchPromise, timeoutPromise]) as any[];
      
      if (!squareGiftCards || !Array.isArray(squareGiftCards)) {
        throw new Error('Failed to fetch gift cards: Invalid response format');
      }
      
      // Set a reasonable limit to prevent processing too many cards at once
      const maxCardsToProcess = 1000; // Adjust as needed
      const cardsToProcess = squareGiftCards.slice(0, maxCardsToProcess);
      
      // Update state with total items
      await this.updateSyncState(state.id, {
        totalCount: cardsToProcess.length,
        status: `Found ${cardsToProcess.length} gift cards to sync${cardsToProcess.length < squareGiftCards.length ? ' (limited to prevent timeout)' : ''}`
      });
      
      // Process each gift card
      for (const squareGiftCard of cardsToProcess) {
        try {
          // Convert Square gift card to our data model
          const giftCardData = squareClient.convertSquareGiftCardToGiftCard(squareGiftCard);
          
          // Check if gift card exists
          let existingGiftCard;
          try {
            // Ensure gan is a string and not null/undefined
            const gan = giftCardData.gan || '';
            if (gan) {
              existingGiftCard = await giftCardService.getGiftCardByGAN(gan);
            }
          } catch (error) {
            // Gift card doesn't exist, which is fine
          }
          
          if (existingGiftCard) {
            // Gift card exists, skip for now (could implement update logic here)
            updated++;
          } else {
            // Gift card doesn't exist, create it
            await giftCardService.createGiftCard(giftCardData);
            created++;
          }
          
          processed++;
          
          // Update sync state progress
          if (processed % 10 === 0 || processed === cardsToProcess.length) {
            await this.updateSyncState(state.id, {
              processedCount: processed,
              status: `Processed ${processed} of ${cardsToProcess.length} gift cards`
            });
          }
        } catch (error) {
          failed++;
          console.error('Failed to process gift card:', error);
        }
      }
      
      // If successful, run the gift card activation amount fix
      await giftCardService.fixGiftCardActivationAmounts();
      
      // Update state to completed
      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date(),
        processedCount: processed
      });
      
      return { processed, created, updated, failed };
    } catch (error) {
      // Update state to error
      const state = await this.getSyncState('giftCards');
      
      if (state) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      
      throw new SyncError(
        'Failed to sync gift cards',
        'SYNC_ERROR',
        error instanceof Error ? error.message : error
      );
    }
  }
}

// Create and export a singleton instance
export const syncService = new SyncService();