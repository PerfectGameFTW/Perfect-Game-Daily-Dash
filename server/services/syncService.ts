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
  giftCards,
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
  /**
   * @deprecated Use syncGiftCardsHistoricalBackfill() instead.
   * This listGiftCards-based path is retained for reference only and must NOT
   * be called by any active sync path (scheduler, routes, or runHistoricalSync).
   * All full-sync entrypoints route to the Activities-API-based canonical method.
   */
  async syncGiftCards(): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    alreadyRunning?: boolean;
  }> {
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;

    try {
      // Guard against concurrent runs
      let state = await this.getSyncState('giftCards');
      if (state && state.status === 'in_progress') {
        const elapsed = Date.now() - new Date(state.lastSyncedAt!).getTime();
        if (elapsed < 30 * 60 * 1000) {
          console.log(`[GiftCardSync] Already in progress since ${state.lastSyncedAt}`);
          return { processed: state.processedCount || 0, created, updated, failed, alreadyRunning: true };
        }
        console.log(`[GiftCardSync] Previous run appears stuck (${Math.round(elapsed / 60000)}m), restarting`);
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

      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        lastSyncedAt: new Date(),
        processedCount: 0,
        totalCount: 0,
        errorMessage: null
      });

      // Fetch all cards + activation amounts from Square in parallel
      let squareGiftCards: any[] = [];
      let activationMap = new Map<string, number>();
      try {
        [squareGiftCards, activationMap] = await Promise.all([
          squareClient.fetchGiftCards(),
          squareClient.fetchGiftCardActivitiesMap()
        ]);
        if (!Array.isArray(squareGiftCards)) throw new Error('Invalid gift card response format');
        console.log(`[GiftCardSync] Fetched ${squareGiftCards.length} cards from Square; ${activationMap.size} activation amounts`);
      } catch (error) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Fetch failed'
        });
        throw error;
      }

      await this.updateSyncState(state.id, {
        totalCount: squareGiftCards.length,
        status: `Processing all ${squareGiftCards.length} gift cards`
      });

      // Load all existing squareIds from our DB in one query so we can
      // distinguish new cards from existing ones without a DB round-trip per card.
      const existingRows = await db.select({ squareId: giftCards.squareId }).from(giftCards);
      const existingSquareIds = new Set(existingRows.map(r => r.squareId));
      console.log(`[GiftCardSync] DB has ${existingSquareIds.size} existing cards`);

      // Process in batches of 100 to avoid large single transactions
      const BATCH = 100;
      for (let i = 0; i < squareGiftCards.length; i += BATCH) {
        const batch = squareGiftCards.slice(i, i + BATCH);

        for (const squareCard of batch) {
          try {
            const squareId = squareCard.id || squareCard.squareId;
            const activationAmount = squareId ? activationMap.get(squareId) : undefined;
            const cardData = squareClient.convertSquareGiftCardToGiftCard(squareCard, activationAmount);

            if (existingSquareIds.has(squareId)) {
              // Update balance, active status, and activation amount if we now have it
              await db.update(giftCards)
                .set({
                  amount: cardData.amount,
                  isActive: cardData.isActive,
                  ...(cardData.activationAmount != null ? { activationAmount: cardData.activationAmount } : {}),
                  updatedAt: new Date()
                })
                .where(eq(giftCards.squareId, squareId));
              updated++;
            } else {
              // Brand-new card — insert it
              await giftCardService.createGiftCard(cardData);
              existingSquareIds.add(squareId); // prevent duplicate inserts in same run
              created++;
            }
            processed++;
          } catch (err) {
            failed++;
            console.error(`[GiftCardSync] Failed card ${squareCard.id}:`, err);
          }
        }

        // Update progress every batch
        await this.updateSyncState(state.id, {
          processedCount: processed,
          status: `Processed ${processed} of ${squareGiftCards.length} gift cards`
        });
      }

      console.log(`[GiftCardSync] Done — processed=${processed} created=${created} updated=${updated} failed=${failed}`);

      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date(),
        processedCount: processed
      });

      return { processed, created, updated, failed };
    } catch (error) {
      const s = await this.getSyncState('giftCards');
      if (s) {
        await this.updateSyncState(s.id, {
          isComplete: true,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      throw new SyncError('Failed to sync gift cards', 'SYNC_ERROR', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Incremental gift card sync — runs every 5 minutes.
   *
   * Instead of re-scanning all 8,000+ Square gift cards, this method:
   *   1. Reads the last successful sync watermark (defaults to 7 days ago on first run).
   *   2. Uses a 2-minute overlap on the lookback window to avoid dropping boundary events.
   *   3. Fetches ACTIVATE activities from Square, stopping once events are older than the window.
   *   4. Deduplicates by giftCardId (keeps highest activation amount per card).
   *   5. For each unique new activation: fetches the card and upserts it.
   *   6. Only advances the watermark to the run-start time when ALL cards succeed.
   *      If any card fails, the watermark is unchanged so the next cycle retries.
   */
  async syncIncrementalGiftCards(): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    sinceDate: string;
  }> {
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;

    // Capture run start before any I/O — this becomes the new watermark on success
    const runStartedAt = new Date();

    const SYNC_TYPE = 'giftCards_incremental';
    const OVERLAP_MS = 2 * 60 * 1000;          // 2-min overlap to catch boundary events
    const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

    let state = await this.getSyncState(SYNC_TYPE);

    // Concurrency guard — skip if a previous run is still in progress
    if (state?.status === 'in_progress') {
      console.log('[IncrementalGiftCardSync] Previous run still in progress — skipping this cycle');
      return { processed: 0, created: 0, updated: 0, failed: 0, sinceDate: 'skipped' };
    }

    // Determine the lookback cutoff (with overlap buffer)
    const lastWatermark: Date = (state?.lastSyncedAt && state.status === 'completed')
      ? new Date(state.lastSyncedAt)
      : new Date(runStartedAt.getTime() - DEFAULT_LOOKBACK_MS);
    const since = new Date(lastWatermark.getTime() - OVERLAP_MS);

    console.log(`[IncrementalGiftCardSync] Window: ${since.toISOString()} → ${runStartedAt.toISOString()} (overlap=${OVERLAP_MS / 1000}s)`);

    // Upsert sync state to in_progress (do NOT advance lastSyncedAt yet)
    if (!state) {
      state = await this.createSyncState({
        syncType: SYNC_TYPE,
        lastSyncedAt: lastWatermark, // keep old watermark until this run succeeds
        isComplete: false,
        processedCount: 0,
        totalCount: 0,
        status: 'in_progress',
        errorMessage: null
      });
    } else {
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        errorMessage: null
        // intentionally NOT updating lastSyncedAt here
      });
    }

    try {
      // Fetch ACTIVATE events in the window
      const recentActivations = await squareClient.fetchRecentGiftCardActivations(since);

      if (recentActivations.length === 0) {
        console.log('[IncrementalGiftCardSync] No new activations found.');
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'completed',
          lastSyncedAt: runStartedAt, // advance watermark — no work to do
          processedCount: 0
        });
        return { processed: 0, created: 0, updated: 0, failed: 0, sinceDate: since.toISOString() };
      }

      // Deduplicate by giftCardId — keep highest activation amount in case of duplicates
      const uniqueActivations = new Map<string, number>();
      for (const { giftCardId, activationAmountDollars } of recentActivations) {
        const existing = uniqueActivations.get(giftCardId) ?? 0;
        if (activationAmountDollars > existing) {
          uniqueActivations.set(giftCardId, activationAmountDollars);
        }
      }

      console.log(`[IncrementalGiftCardSync] Processing ${uniqueActivations.size} unique activations (${recentActivations.length} raw events)`);

      // Load existing squareIds for fast lookup (avoids per-card DB query)
      const existingRows = await db.select({ squareId: giftCards.squareId }).from(giftCards);
      const existingSquareIds = new Set(existingRows.map(r => r.squareId));

      await this.updateSyncState(state.id, {
        totalCount: uniqueActivations.size,
        status: `Processing ${uniqueActivations.size} unique activations`
      });

      for (const [giftCardId, activationAmountDollars] of Array.from(uniqueActivations)) {
        try {
          if (existingSquareIds.has(giftCardId)) {
            // Card already exists — fill in activation amount if still null
            await db.update(giftCards)
              .set({
                activationAmount: activationAmountDollars,
                updatedAt: new Date()
              })
              .where(
                and(
                  eq(giftCards.squareId, giftCardId),
                  isNull(giftCards.activationAmount)
                )
              );
            updated++;
          } else {
            // Brand-new card — fetch from Square and insert
            const squareCard = await squareClient.fetchGiftCardById(giftCardId);
            if (!squareCard) {
              console.warn(`[IncrementalGiftCardSync] Could not fetch card ${giftCardId} from Square — will retry next cycle`);
              failed++;
              continue;
            }

            const cardData = squareClient.convertSquareGiftCardToGiftCard(squareCard, activationAmountDollars);
            await giftCardService.createGiftCard(cardData);
            existingSquareIds.add(giftCardId); // prevent double-insert in same run
            created++;
          }

          processed++;
        } catch (err) {
          failed++;
          console.error(`[IncrementalGiftCardSync] Failed for card ${giftCardId}:`, err);
        }
      }

      console.log(`[IncrementalGiftCardSync] Done — processed=${processed} created=${created} updated=${updated} failed=${failed}`);

      if (failed === 0) {
        // Advance watermark to run-start time — next cycle picks up from here
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'completed',
          lastSyncedAt: runStartedAt,
          processedCount: processed
        });
      } else {
        // Keep existing watermark so next cycle retries the failed cards
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: `completed_with_errors (${failed} cards failed — will retry)`,
          processedCount: processed,
          errorMessage: `${failed} card(s) failed; watermark not advanced so next cycle retries`
        });
        console.warn(`[IncrementalGiftCardSync] ${failed} card(s) failed — watermark held at ${lastWatermark.toISOString()} for retry`);
      }

      return { processed, created, updated, failed, sinceDate: since.toISOString() };
    } catch (error) {
      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
        // watermark NOT advanced — entire run retried next cycle
      });
      console.error('[IncrementalGiftCardSync] Fatal error:', error);
      return { processed, created, updated, failed, sinceDate: since.toISOString() };
    }
  }

  /**
   * Resumable historical gift card backfill via Activities API.
   *
   * Unlike syncGiftCards() which uses listGiftCards (no date filter, arbitrary order,
   * loses progress on restart), this method:
   *   1. Pages through ALL ACTIVATE events ASC (oldest → newest) using the Activities API.
   *   2. Saves the API cursor after every page using the 'giftCards_historical' sync key.
   *   3. On restart it reads the saved cursor and resumes mid-scan — no data is re-processed
   *      from the beginning.
   *   4. For each activation event it UPSERTs the card with the correct UTC purchase_date
   *      (fixing the timezone bug for any newly inserted records) and the authoritative
   *      activation amount from the event.
   *
   * This is the fix for the March 9-20 gap: those 228 cards live in pages that were
   * never reached before a server restart when using listGiftCards.
   */
  async syncGiftCardsHistoricalBackfill(): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    pagesProcessed: number;
    finished: boolean;
  }> {
    const SYNC_TYPE = 'giftCards_historical';
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;
    let pagesProcessed = 0;

    let state = await this.getSyncState(SYNC_TYPE);

    // Concurrency guard: allow 3 minutes for a run to complete before treating it as stuck.
    // (Each call completes in <1 min with the pre-loaded card map — 30 min was too long,
    //  and would block the startup loop for ages after a server restart.)
    if (state?.status === 'in_progress') {
      const elapsed = state.lastSyncedAt ? Date.now() - new Date(state.lastSyncedAt).getTime() : Infinity;
      if (elapsed < 3 * 60 * 1000) {
        console.log('[HistoricalGiftCardBackfill] Previous run still in progress — skipping');
        return { processed: 0, created: 0, updated: 0, failed: 0, pagesProcessed: 0, finished: false };
      }
      console.log('[HistoricalGiftCardBackfill] Previous run appears stuck — restarting');
    }

    // Read saved cursor from errorMessage field (repurposed as a checkpoint store)
    let savedCursor: string | undefined = undefined;
    if (state?.errorMessage?.startsWith('cursor:')) {
      savedCursor = state.errorMessage.slice('cursor:'.length) || undefined;
      console.log(`[HistoricalGiftCardBackfill] Resuming from saved cursor (${savedCursor?.slice(0, 20)}...)`);
    } else {
      console.log('[HistoricalGiftCardBackfill] Starting from beginning (no saved cursor)');
    }

    // Mark as in_progress
    if (!state) {
      state = await this.createSyncState({
        syncType: SYNC_TYPE,
        lastSyncedAt: new Date(),
        isComplete: false,
        processedCount: 0,
        totalCount: 0,
        status: 'in_progress',
        errorMessage: savedCursor ? `cursor:${savedCursor}` : null
      });
    } else {
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        lastSyncedAt: new Date(),
      });
    }

    // Pre-load ALL Square gift cards into a map (squareId → card data).
    // This avoids per-card API calls inside the activation-event loop — instead we
    // do a single bulk fetch up front and look up cards from the in-memory map.
    console.log('[HistoricalGiftCardBackfill] Pre-loading all Square gift cards...');
    const allSquareCards = await squareClient.fetchGiftCards();
    const squareCardMap = new Map<string, any>();
    for (const card of allSquareCards) {
      const id = card.id || card.squareId;
      if (id) squareCardMap.set(id, card);
    }
    console.log(`[HistoricalGiftCardBackfill] Pre-loaded ${squareCardMap.size} Square cards`);

    // Load all existing squareIds once for fast lookup
    const existingRows = await db.select({ squareId: giftCards.squareId }).from(giftCards);
    const existingSquareIds = new Set(existingRows.map(r => r.squareId));

    let currentCursor = savedCursor;
    let finished = false;

    try {
      // Process up to 20 pages per call (1,000 activities) to keep response times reasonable.
      // The endpoint will be called again to continue from where we left off.
      const MAX_PAGES_PER_CALL = 20;

      for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
        const { activities, nextCursor } = await squareClient.fetchGiftCardActivitiesPage(currentCursor, 'ASC');
        pagesProcessed++;

        console.log(`[HistoricalGiftCardBackfill] Page ${page + 1}: ${activities.length} ACTIVATE events (cursor: ${currentCursor?.slice(0, 20) ?? 'start'})`);

        for (const { giftCardId, activationAmountDollars, createdAt } of activities) {
          try {
            // Look up from the pre-loaded map — avoids a per-card API call.
            // Fall back to fetchGiftCardById only for cards not in the bulk list
            // (e.g., cancelled/expired cards Square omits from listGiftCards).
            let squareCard = squareCardMap.get(giftCardId);
            if (!squareCard) {
              squareCard = await squareClient.fetchGiftCardById(giftCardId);
              if (!squareCard) {
                console.warn(`[HistoricalGiftCardBackfill] Could not resolve card ${giftCardId}`);
                failed++;
                continue;
              }
            }

            // Build the canonical card data (with correct UTC purchase_date)
            const cardData = squareClient.convertSquareGiftCardToGiftCard(squareCard, activationAmountDollars);
            // Use the authoritative createdAt from the Activities API event (correct UTC)
            cardData.purchaseDate = createdAt;

            if (existingSquareIds.has(giftCardId)) {
              // Card exists — upsert current balance and active status from Square.
              // For purchaseDate, keep the EARLIEST activation event: since the backfill
              // iterates ASC (oldest first), a later activation event should NOT overwrite
              // a purchase_date that was set from an earlier event.
              await db.update(giftCards)
                .set({
                  amount: cardData.amount,
                  isActive: cardData.isActive,
                  activationAmount: activationAmountDollars,
                  purchaseDate: sql`CASE WHEN ${giftCards.purchaseDate} IS NULL OR ${giftCards.purchaseDate} > ${createdAt} THEN ${createdAt} ELSE ${giftCards.purchaseDate} END`,
                  updatedAt: new Date()
                })
                .where(eq(giftCards.squareId, giftCardId));
              updated++;
            } else {
              // Brand-new card — insert it
              await giftCardService.createGiftCard(cardData);
              existingSquareIds.add(giftCardId);
              created++;
            }
            processed++;
          } catch (err) {
            failed++;
            console.error(`[HistoricalGiftCardBackfill] Failed for card ${giftCardId}:`, err);
          }
        }

        currentCursor = nextCursor;

        // Save cursor checkpoint after each page so restarts resume here
        await this.updateSyncState(state.id, {
          processedCount: (state.processedCount || 0) + processed,
          status: `in_progress — page ${pagesProcessed} processed`,
          errorMessage: currentCursor ? `cursor:${currentCursor}` : 'cursor:done'
        });

        if (!nextCursor) {
          finished = true;
          break;
        }
      }

      if (finished) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'completed',
          lastSyncedAt: new Date(),
          processedCount: (state.processedCount || 0) + processed,
          errorMessage: null // clear cursor checkpoint — done
        });
        console.log(`[HistoricalGiftCardBackfill] COMPLETE — processed=${processed} created=${created} updated=${updated} failed=${failed}`);
      } else {
        await this.updateSyncState(state.id, {
          isComplete: false,
          status: `paused — call again to continue (${pagesProcessed} pages this run)`,
          lastSyncedAt: new Date(),
          processedCount: (state.processedCount || 0) + processed,
          // errorMessage already updated with cursor above
        });
        console.log(`[HistoricalGiftCardBackfill] Paused after ${pagesProcessed} pages — cursor saved, call again to continue`);
      }

      return { processed, created, updated, failed, pagesProcessed, finished };
    } catch (error) {
      // Save current cursor so we can resume from last successful page
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'error — will resume from checkpoint on next call',
        errorMessage: currentCursor ? `cursor:${currentCursor}` : (savedCursor ? `cursor:${savedCursor}` : null)
      });
      console.error('[HistoricalGiftCardBackfill] Error:', error);
      throw error;
    }
  }
}

// Create and export a singleton instance
export const syncService = new SyncService();