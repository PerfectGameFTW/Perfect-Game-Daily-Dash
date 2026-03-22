/**
 * Gift Card Service
 * 
 * Handles all gift card-related business logic with proper error handling
 * and data validation. Provides a clean API for the rest of the application.
 */

import { db } from '../db';
import { eq, and, between, desc, asc, sql, isNull, gt } from 'drizzle-orm';
import { 
  giftCards,
  orders,
  syncState,
  giftCardRedemptions,
  transactions,
  type GiftCard, 
  type InsertGiftCard,
  type GiftCardRedemption,
  type InsertGiftCardRedemption,
  type DateRange,
  type GiftCardSummary
} from '../../shared/schema';
import { getEasternDateRange } from '../dateUtils';
import { fetchOrdersByIds, fetchGiftCardActivitiesPage } from '../squareClient';

export class GiftCardError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'GiftCardError';
  }
}

export class GiftCardNotFoundError extends GiftCardError {
  constructor(giftCardId: string | number) {
    super(`Gift card with ID ${giftCardId} not found`, 'GIFT_CARD_NOT_FOUND');
    this.name = 'GiftCardNotFoundError';
  }
}

export class InsufficientBalanceError extends GiftCardError {
  constructor(giftCardId: string | number, requestedAmount: number, currentBalance: number) {
    super(
      `Gift card ${giftCardId} has insufficient balance. Requested: ${requestedAmount}, Available: ${currentBalance}`,
      'INSUFFICIENT_BALANCE',
      { requestedAmount, currentBalance }
    );
    this.name = 'InsufficientBalanceError';
  }
}

export class GiftCardService {
  /**
   * Get a gift card by ID
   * 
   * @param id The gift card ID
   * @returns The gift card or throws if not found
   */
  async getGiftCardById(id: number): Promise<GiftCard> {
    const result = await db.select().from(giftCards).where(eq(giftCards.id, id)).limit(1);
    
    if (!result.length) {
      throw new GiftCardNotFoundError(id);
    }
    
    return result[0];
  }
  
  /**
   * Get a gift card by Square ID (GAN)
   * 
   * @param gan The gift card account number (GAN)
   * @returns The gift card or throws if not found
   */
  async getGiftCardByGAN(gan: string): Promise<GiftCard> {
    const result = await db.select().from(giftCards).where(eq(giftCards.gan, gan)).limit(1);
    
    if (!result.length) {
      throw new GiftCardNotFoundError(gan);
    }
    
    return result[0];
  }
  
  /**
   * Create a new gift card with automatic order linking
   * 
   * This enhanced version not only creates a gift card but also:
   * 1. Automatically finds the purchase order for accurate activation amount
   * 2. Links the gift card to its activation order permanently
   * 3. Sets the proper activation amount based on order data
   * 
   * @param giftCardData The gift card data to insert
   * @returns The created gift card with accurate activation amount
   */
  async createGiftCard(giftCardData: InsertGiftCard): Promise<GiftCard> {
    // First create the gift card with the data provided
    const result = await db.insert(giftCards).values(giftCardData).returning();
    
    if (!result.length) {
      throw new GiftCardError('Failed to create gift card', 'DB_ERROR');
    }
    
    // Get the created gift card
    const newGiftCard = result[0];
    
    try {
      // Now enhance it with accurate activation amount by linking to its order
      console.log(`Linking new gift card ${newGiftCard.id} to its order for accurate activation amount...`);
      
      // Import the enhanced gift card fix function for single cards
      const { fixNewGiftCardActivationAmount } = await import('./enhancedGiftCardFix');
      
      // Fix the new gift card's activation amount
      const enhancedGiftCardResult = await fixNewGiftCardActivationAmount(newGiftCard.id);
      
      // If the enhancement was successful, update the gift card with the new data
      if (enhancedGiftCardResult && enhancedGiftCardResult.updated && enhancedGiftCardResult.activationAmount) {
        // Update the gift card with the enhanced data
        return {
          ...newGiftCard,
          activationAmount: enhancedGiftCardResult.activationAmount,
          activationOrderId: enhancedGiftCardResult.orderId || null,
          activationSquareOrderId: enhancedGiftCardResult.squareOrderId || null
        };
      }
    } catch (error) {
      // Log the error but don't fail - we'll just return the original gift card
      console.error(`Error enhancing new gift card ${newGiftCard.id}:`, error);
      console.log('Continuing with original gift card data');
    }
    
    // Return the original gift card if enhancement failed
    return newGiftCard;
  }
  
  /**
   * Process a gift card redemption
   * 
   * @param giftCardId The gift card ID
   * @param amount The redemption amount
   * @param paymentId Optional payment ID associated with the redemption
   * @param orderId Optional order ID associated with the redemption
   * @returns The updated gift card
   */
  async processRedemption(
    giftCardId: number,
    amount: number,
    paymentId?: number,
    orderId?: number
  ): Promise<GiftCard> {
    return await db.transaction(async (tx) => {
      // Get the gift card with locking for update
      const giftCard = await tx.select().from(giftCards)
        .where(eq(giftCards.id, giftCardId))
        .limit(1);
      
      if (!giftCard.length) {
        throw new GiftCardNotFoundError(giftCardId);
      }
      
      const currentCard = giftCard[0];
      const currentBalance = currentCard.amount || 0;
      
      // Check if balance is sufficient
      if (currentBalance < amount) {
        throw new InsufficientBalanceError(giftCardId, amount, currentBalance);
      }
      
      // Update gift card balance
      const newBalance = currentBalance - amount;
      const newRedeemedAmount = (currentCard.redeemedAmount || 0) + amount;
      
      // Create a new object for square data
      const updatedSquareData = typeof currentCard.squareData === 'object' && currentCard.squareData !== null
        ? { ...currentCard.squareData, lastRedemptionDate: new Date().toISOString() }
        : { lastRedemptionDate: new Date().toISOString() };

      const updatedCard = await tx.update(giftCards)
        .set({
          amount: newBalance,
          redeemedAmount: newRedeemedAmount,
          squareData: updatedSquareData
        })
        .where(eq(giftCards.id, giftCardId))
        .returning();
      
      if (!updatedCard.length) {
        throw new GiftCardError('Failed to update gift card balance', 'DB_ERROR');
      }
      
      // Create redemption record - align with schema
      // Transaction ID is required by the schema, so we must ensure it has a value
      const transactionId = typeof paymentId === 'number' ? paymentId : 0;
      
      const redemptionData: InsertGiftCardRedemption = {
        giftCardId,
        amount,
        timestamp: new Date(),
        transactionId: transactionId  // Use the definitely-typed transaction ID
      };
      
      await tx.insert(giftCardRedemptions).values(redemptionData);
      
      return updatedCard[0];
    });
  }
  
  /**
   * Get redemptions for a gift card
   * 
   * @param giftCardId The gift card ID
   * @returns Array of redemptions
   */
  async getRedemptions(giftCardId: number): Promise<GiftCardRedemption[]> {
    return await db.select().from(giftCardRedemptions)
      .where(eq(giftCardRedemptions.giftCardId, giftCardId))
      .orderBy(desc(giftCardRedemptions.timestamp));
  }
  
  /**
   * Get gift card summary for a date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Gift card summary including sales and redemptions
   */
  async getGiftCardSummary(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<GiftCardSummary> {
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    console.log(`Getting gift card summary with UTC dates: {
  dateRange: '${dateRange}',
  startUTC: '${start.toISOString()}',
  endUTC: '${end.toISOString()}',
  startDate: ${startDate ? `'${startDate.toISOString()}'` : 'undefined'},
  endDate: ${endDate ? `'${endDate.toISOString()}'` : 'undefined'}
}`);
    
    // Query the database for gift card activations using Drizzle's SQL template
    // which properly handles parameterized queries
    const activationsResult = await db.execute(sql`
      SELECT 
        COUNT(*) as sold_count,
        COALESCE(SUM(activation_amount), 0) as sold_amount
      FROM gift_cards
      WHERE purchase_date BETWEEN ${start} AND ${end}
        AND activation_amount > 0
    `);
    
    console.log(`Gift card activations raw result:`, JSON.stringify(activationsResult.rows));
    
    // Query the database for gift card redemptions using Drizzle's SQL template
    // which properly handles parameterized queries
    const redemptionsResult = await db.execute(sql`
      SELECT 
        COUNT(*) as redeemed_count,
        COALESCE(SUM(amount), 0) as redeemed_amount
      FROM gift_card_redemptions
      WHERE timestamp BETWEEN ${start} AND ${end}
    `);
    
    console.log(`Gift card redemptions raw result:`, JSON.stringify(redemptionsResult.rows));
    
    // Access the result properly from the raw SQL query results
    // Convert all values to numbers to avoid type issues
    const soldCount = parseInt(String(activationsResult.rows?.[0]?.sold_count || '0'), 10) || 0;
    const soldAmount = parseFloat(String(activationsResult.rows?.[0]?.sold_amount || '0')) || 0;
    const redeemedCount = parseInt(String(redemptionsResult.rows?.[0]?.redeemed_count || '0'), 10) || 0;
    const redeemedAmount = parseFloat(String(redemptionsResult.rows?.[0]?.redeemed_amount || '0')) || 0;
    const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;
    
    console.log(`Gift card summary calculated using proper Eastern timezone boundaries: {
  dateRange: '${dateRange}',
  soldCount: ${soldCount},
  soldAmount: ${soldAmount},
  redeemedCount: ${redeemedCount},
  redeemedAmount: ${redeemedAmount},
  averageValue: ${averageValue},
  dateRangeStr: '${start.toISOString()} to ${end.toISOString()}'
}`);
    
    return {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue
    };
  }
  
  /**
   * Get gift card sales total for a date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Total gift card sales amount
   */
  async getGiftCardSales(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<number> {
    const breakdown = await this.getGiftCardBreakdown(dateRange, startDate, endDate);
    return breakdown.giftCardSales;
  }

  /**
   * Return gift card activations split into three buckets for the business day:
   *  - bowlingWebResDeposits: gift cards whose activation_square_order_id links to a
   *    'Web Reservation' order
   *  - laserTagWebResDeposits: gift cards whose activation_square_order_id links to a
   *    'Web Reservation-Attraction' order
   *  - giftCardSales: all other activations — NULL activation_square_order_id or order
   *    with a different source (genuine gift card purchases)
   *
   * activation_square_order_id is populated by:
   *   1. squareClient ACTIVATE event capture (when Square returns orderId in API response)
   *   2. backfillActivationSquareOrderIds() — a one-time startup routine that matches
   *      gift cards to Web Reservation orders by activation_amount + time proximity
   */
  async getGiftCardBreakdown(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<{ bowlingWebResDeposits: number; laserTagWebResDeposits: number; giftCardSales: number }> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

    const result = await db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN o.source = 'Web Reservation'             THEN gc.activation_amount ELSE 0 END), 0) AS bowling_web_res,
        COALESCE(SUM(CASE WHEN o.source = 'Web Reservation-Attraction'  THEN gc.activation_amount ELSE 0 END), 0) AS laser_tag_web_res,
        COALESCE(SUM(CASE WHEN o.source IS NULL
                           OR o.source NOT IN ('Web Reservation', 'Web Reservation-Attraction')
                                              THEN gc.activation_amount ELSE 0 END), 0) AS gift_card_sales
      FROM gift_cards gc
      LEFT JOIN orders o ON o.square_id = gc.activation_square_order_id
      WHERE gc.purchase_date BETWEEN ${start} AND ${end}
        AND gc.activation_amount > 0
    `);

    const row = result.rows?.[0] ?? {};
    return {
      bowlingWebResDeposits: parseFloat(String(row.bowling_web_res  || '0')) || 0,
      laserTagWebResDeposits: parseFloat(String(row.laser_tag_web_res || '0')) || 0,
      giftCardSales:          parseFloat(String(row.gift_card_sales  || '0')) || 0,
    };
  }

  /**
   * PRIMARY backfill — Phase 0: scans ALL Square ACTIVATE events and writes
   * activation_square_order_id for any gift card where Square returned an orderId.
   *
   * Uses a dedicated sync state key ('gift_card_order_id_history') so it:
   *   - Runs independently of the historical gift card backfill completion state
   *   - Is resumable: saves the Square cursor after every page so a restart
   *     continues where it left off
   *   - After the first full scan (isComplete=true), subsequent calls only scan
   *     events newer than lastSyncedAt (incremental)
   *
   * ACTIVATE-event-derived orderId is considered authoritative.
   * Only updates rows where activation_square_order_id IS NULL (never overwrites).
   *
   * @returns { scanned, linked } — events inspected and order IDs written
   */
  async backfillActivationOrderIdsFromActivateHistory(): Promise<{ scanned: number; linked: number }> {
    const STATE_KEY = 'gift_card_order_id_history';

    // Load existing sync state for this backfill (separate from historical backfill state)
    const [existing] = await db.select().from(syncState)
      .where(eq(syncState.syncType, STATE_KEY))
      .limit(1);

    let stateRow = existing ?? null;
    let scanned = 0;
    let linked = 0;

    // Incremental mode: full scan done previously — only process new events
    if (stateRow?.isComplete && stateRow.lastSyncedAt) {
      const since = stateRow.lastSyncedAt;
      console.log(`[GiftCardOrderIdBackfill] Incremental scan since ${since.toISOString()}`);
      let cursor: string | undefined;
      let pageNum = 0;
      while (true) {
        const { activities, nextCursor } = await fetchGiftCardActivitiesPage(cursor, 'DESC');
        pageNum++;
        let reachedCutoff = false;
        for (const { giftCardId, squareOrderId, createdAt } of activities) {
          if (createdAt <= since) { reachedCutoff = true; break; }
          scanned++;
          if (!squareOrderId) continue;
          const rows = await db.update(giftCards)
            .set({ activationSquareOrderId: squareOrderId, updatedAt: new Date() })
            .where(and(eq(giftCards.squareId, giftCardId), isNull(giftCards.activationSquareOrderId)))
            .returning({ id: giftCards.id });
          if (rows.length > 0) linked++;
        }
        if (reachedCutoff || !nextCursor || activities.length === 0) break;
        cursor = nextCursor;
      }
      await db.update(syncState)
        .set({ lastSyncedAt: new Date(), processedCount: (stateRow.processedCount ?? 0) + scanned })
        .where(eq(syncState.id, stateRow.id));
      console.log(`[GiftCardOrderIdBackfill] Incremental done: ${scanned} scanned, ${linked} linked`);
      return { scanned, linked };
    }

    // Full scan (first run or resumed after restart)
    const savedCursor = stateRow?.cursor || undefined;
    const isResume = !!savedCursor;
    console.log(`[GiftCardOrderIdBackfill] ${isResume ? 'Resuming' : 'Starting'} full ACTIVATE history scan`);

    if (!stateRow) {
      const [created] = await db.insert(syncState).values({
        syncType: STATE_KEY,
        lastSyncedAt: new Date(),
        status: 'running',
        processedCount: 0,
        cursor: '',
      }).returning();
      stateRow = created;
    } else {
      await db.update(syncState)
        .set({ status: 'running' })
        .where(eq(syncState.id, stateRow.id));
    }

    let cursor: string | undefined = savedCursor;
    let pageNum = 0;
    while (true) {
      const { activities, nextCursor } = await fetchGiftCardActivitiesPage(cursor, 'DESC');
      pageNum++;
      for (const { giftCardId, squareOrderId } of activities) {
        scanned++;
        if (!squareOrderId) continue;
        const rows = await db.update(giftCards)
          .set({ activationSquareOrderId: squareOrderId, updatedAt: new Date() })
          .where(and(eq(giftCards.squareId, giftCardId), isNull(giftCards.activationSquareOrderId)))
          .returning({ id: giftCards.id });
        if (rows.length > 0) linked++;
      }
      cursor = nextCursor;
      // Persist cursor so a restart can resume
      await db.update(syncState)
        .set({ cursor: cursor ?? '', processedCount: scanned, lastSyncedAt: new Date() })
        .where(eq(syncState.id, stateRow.id));
      if (pageNum % 20 === 0) {
        console.log(`[GiftCardOrderIdBackfill] Page ${pageNum}: ${scanned} events scanned, ${linked} linked`);
      }
      if (!cursor || activities.length === 0) break;
    }

    await db.update(syncState)
      .set({ isComplete: true, status: 'completed', processedCount: scanned, lastSyncedAt: new Date() })
      .where(eq(syncState.id, stateRow.id));
    console.log(`[GiftCardOrderIdBackfill] Full scan complete: ${scanned} events, ${linked} order IDs linked`);
    return { scanned, linked };
  }

  /**
   * FALLBACK backfill — Phase 2: write activation_square_order_id for gift cards
   * where Square's ACTIVATE events did NOT return an orderId.
   *
   * Matching strategy: activation_amount = order.total_money AND
   *   |gc.purchase_date - order.created_at| < 5 minutes AND
   *   order.source IN ('Web Reservation', 'Web Reservation-Attraction')
   *
   * @param orderDateRange  Optional date window to scope the order search. When provided
   *   (e.g. during per-chunk backfill), only orders whose created_at falls within
   *   [start, end) are candidates — avoids repeated full-table scans.
   *   Omit (or pass undefined) for a global scan (e.g. the final post-backfill run).
   */
  async backfillActivationSquareOrderIds(
    orderDateRange?: { start: Date; end: Date }
  ): Promise<{ updated: number }> {
    const dateFilter = orderDateRange
      ? sql`AND o.created_at >= ${orderDateRange.start.toISOString()} AND o.created_at < ${orderDateRange.end.toISOString()}`
      : sql``;

    const result = await db.execute(sql`
      UPDATE gift_cards gc
      SET activation_square_order_id = matched.square_id,
          updated_at = NOW()
      FROM (
        SELECT DISTINCT ON (gc2.id)
          gc2.id AS gc_id,
          o.square_id
        FROM gift_cards gc2
        JOIN orders o
          ON  o.total_money = gc2.activation_amount
          AND o.source IN ('Web Reservation', 'Web Reservation-Attraction')
          AND ABS(EXTRACT(EPOCH FROM (gc2.purchase_date - o.created_at))) < 300
          ${dateFilter}
        WHERE gc2.activation_square_order_id IS NULL
          AND gc2.activation_amount > 0
        ORDER BY gc2.id, ABS(EXTRACT(EPOCH FROM (gc2.purchase_date - o.created_at)))
      ) matched
      WHERE gc.id = matched.gc_id
      RETURNING gc.id
    `);

    const updated = result.rows.length;
    console.log(`[GiftCardBackfill] activation_square_order_id backfill: ${updated} rows updated`);
    return { updated };
  }

  /**
   * Sync orders from Square that are referenced by gift cards (via activation_square_order_id)
   * but are not yet present in the local orders table.
   *
   * This happens when the historical gift card backfill discovers orderId values from Square's
   * ACTIVATE activity events, but those orders were created outside the normal order sync window.
   *
   * After this runs, getGiftCardBreakdown()'s LEFT JOIN resolves those order IDs and correctly
   * classifies each card into the Bowling/Laser Tag/Gift Card Sales bucket.
   *
   * @returns count of orders inserted
   */
  async syncMissingActivationOrders(): Promise<{ inserted: number }> {
    // Find activation_square_order_ids that have no matching row in the orders table
    const missing = await db.execute(sql`
      SELECT DISTINCT gc.activation_square_order_id AS order_square_id
      FROM gift_cards gc
      WHERE gc.activation_square_order_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM orders o WHERE o.square_id = gc.activation_square_order_id
        )
    `);

    const missingIds = missing.rows.map(r => String(r.order_square_id));
    if (missingIds.length === 0) {
      console.log('[GiftCardBackfill] No missing activation orders to sync');
      return { inserted: 0 };
    }

    console.log(`[GiftCardBackfill] Fetching ${missingIds.length} missing activation order(s) from Square`);

    const fetched = await fetchOrdersByIds(missingIds);
    if (fetched.length === 0) {
      console.log('[GiftCardBackfill] Square returned 0 orders for missing IDs');
      return { inserted: 0 };
    }

    let inserted = 0;
    for (const order of fetched) {
      try {
        await db.insert(orders).values(order).onConflictDoNothing();
        inserted++;
      } catch (err) {
        console.error(`[GiftCardBackfill] Failed to insert order ${order.squareId}:`, err);
      }
    }

    console.log(`[GiftCardBackfill] Inserted ${inserted} of ${fetched.length} missing activation orders`);
    return { inserted };
  }
  
  /**
   * Find gift cards with missing or incorrect activation amounts
   * 
   * @returns Array of gift cards with issues
   */
  async findGiftCardsWithMissingActivationAmount(): Promise<GiftCard[]> {
    return await db.select().from(giftCards)
      .where(
        and(
          isNull(giftCards.activationAmount),
          eq(giftCards.isActive, true)
        )
      );
  }
  
  /**
   * Fix gift card activation amounts based on payment data
   * 
   * @deprecated Use the more comprehensive solution in giftCardActivationFix.ts instead,
   * which properly links gift cards to orders and extracts accurate activation amounts
   * using multiple matching strategies.
   * 
   * @returns Number of fixed gift cards
   */
  async fixGiftCardActivationAmounts(): Promise<number> {
    console.log('Starting fixGiftCardActivationAmounts process');
    
    // First, let's count how many cards need fixing
    const needFixing = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM gift_cards
      WHERE (activation_amount IS NULL OR activation_amount = 0)
        AND is_active = TRUE
    `);
    
    console.log(`Found ${needFixing.rows?.[0]?.count || 0} gift cards needing activation amount fixes`);
    
    // We need to use a raw query here to properly reference the related gift card
    // Note: The transactions table doesn't have a direct giftCardId column in schema
    // So we're using a subquery to extract gift card ID from the square_data JSON
    const result = await db.execute(sql`
      UPDATE gift_cards gc
      SET 
        activation_amount = GREATEST(
          COALESCE(gc.amount, 0) + COALESCE(gc.redeemed_amount, 0),
          COALESCE((
            SELECT amount
            FROM transactions
            WHERE category_id = 'giftCard'
              AND status = 'completed'
              AND square_id = gc.square_id
            ORDER BY timestamp
            LIMIT 1
          ), 0)
          -- Removed default $50 value to avoid inaccurate data
        )
      WHERE 
        (gc.activation_amount IS NULL OR gc.activation_amount = 0)
        AND gc.is_active = TRUE
      RETURNING id, gan, activation_amount
    `);
    
    console.log(`Fixed ${result.rowCount || 0} gift cards with activation amounts`);
    if (result.rows && result.rows.length > 0) {
      console.log(`Sample fixed cards: ${JSON.stringify(result.rows.slice(0, 5))}`);
    }
    
    // For better accuracy, recommend using the more comprehensive fix from giftCardActivationFix.ts
    console.log('Note: For more accurate activation amounts, use POST /api/fix-gift-cards endpoint');
    
    return result.rowCount || 0;
  }

  /**
   * Process a gift card redemption from a Square payment
   * 
   * This method handles the linking between a Square payment made using a gift card
   * and the corresponding gift card record in our database. It:
   * 1. Finds the gift card by its GAN (Gift Account Number)
   * 2. Creates a redemption record
   * 3. Updates the gift card balance
   * 
   * @param sourceId The Square gift card ID (GAN)
   * @param amount The redemption amount
   * @param paymentId The database ID of the payment/transaction
   * @param squareData Additional Square payment data
   * @returns The processed gift card or null if gift card not found
   */
  async processRedemptionFromSquare(
    sourceId: string,
    amount: number,
    paymentId: number,
    squareData: any = {}
  ): Promise<GiftCard | null> {
    try {
      // Step 1: Find the gift card by GAN (Gift Account Number)
      // First try exact match on squareId
      let giftCard: GiftCard | undefined;
      
      try {
        // Try to find by square ID first
        giftCard = await db.select().from(giftCards)
          .where(eq(giftCards.squareId, sourceId))
          .limit(1)
          .then(results => results[0]);
      } catch (error) {
        console.log(`Gift card not found by squareId ${sourceId}`, error);
      }
      
      // If not found by squareId, try GAN
      if (!giftCard) {
        try {
          giftCard = await db.select().from(giftCards)
            .where(eq(giftCards.gan, sourceId))
            .limit(1)
            .then(results => results[0]);
        } catch (error) {
          console.log(`Gift card not found by gan ${sourceId}`, error);
        }
      }
      
      // If still not found, try searching in the squareData JSON
      if (!giftCard) {
        try {
          // This is a more complex query to search in JSON data
          const cards = await db.execute(sql`
            SELECT * FROM gift_cards
            WHERE square_data::text LIKE ${`%${sourceId}%`}
            LIMIT 1
          `);
          
          if (cards.rows && cards.rows.length > 0) {
            giftCard = cards.rows[0] as GiftCard;
          }
        } catch (error) {
          console.log(`Error searching for gift card in square_data: ${sourceId}`, error);
        }
      }
      
      // If gift card is still not found, log and return null
      if (!giftCard) {
        console.log(`Could not find gift card with ID/GAN: ${sourceId}`);
        return null;
      }
      
      // Step 2: Process the redemption
      return await this.processRedemption(
        giftCard.id,
        amount,
        paymentId
      );
    } catch (error) {
      console.error('Error processing gift card redemption from Square payment:', error);
      return null;
    }
  }
}

// Create and export a singleton instance
export const giftCardService = new GiftCardService();