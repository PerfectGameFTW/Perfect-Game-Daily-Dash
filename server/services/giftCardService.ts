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
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

    const activationsResult = await db.execute(sql`
      SELECT 
        COUNT(*) as sold_count,
        COALESCE(SUM(gc.activation_amount), 0) as sold_amount
      FROM gift_cards gc
      LEFT JOIN orders o ON o.square_id = gc.activation_square_order_id
      WHERE gc.purchase_date BETWEEN ${start} AND ${end}
        AND gc.activation_amount > 0
        AND (o.source IS NULL OR o.source NOT IN ('Web Reservation', 'Web Reservation-Attraction', 'Multi Attractions Reservation'))
    `);

    const redemptionsResult = await db.execute(sql`
      SELECT 
        COUNT(*) as redeemed_count,
        COALESCE(SUM(amount), 0) as redeemed_amount
      FROM gift_card_redemptions
      WHERE timestamp BETWEEN ${start} AND ${end}
    `);

    const outstandingResult = await db.execute(sql`
      SELECT COALESCE(SUM(gc.amount), 0) as outstanding_balance
      FROM gift_cards gc
      WHERE gc.amount > 0
    `);

    const webResAdvResult = await db.execute(sql`
      SELECT COALESCE(SUM(gc.amount), 0) as web_res_adv_deposits
      FROM gift_cards gc
      INNER JOIN orders o ON o.square_id = gc.activation_square_order_id
      WHERE gc.amount > 0
        AND o.source IN ('Web Reservation', 'Web Reservation-Attraction', 'Multi Attractions Reservation')
    `);

    const soldCount = parseInt(String(activationsResult.rows?.[0]?.sold_count || '0'), 10) || 0;
    const soldAmount = parseFloat(String(activationsResult.rows?.[0]?.sold_amount || '0')) || 0;
    const redeemedCount = parseInt(String(redemptionsResult.rows?.[0]?.redeemed_count || '0'), 10) || 0;
    const redeemedAmount = parseFloat(String(redemptionsResult.rows?.[0]?.redeemed_amount || '0')) || 0;
    const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;
    const outstandingBalance = parseFloat(String(outstandingResult.rows?.[0]?.outstanding_balance || '0')) || 0;
    const webResAdvDeposits = parseFloat(String(webResAdvResult.rows?.[0]?.web_res_adv_deposits || '0')) || 0;

    return {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue,
      outstandingBalance,
      webResAdvDeposits
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

    const orderLineItems = sql.identifier('order_line_items');
    const result = await db.execute<{
      bowling_web_res: string;
      laser_tag_web_res: string;
    }>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN o.source = 'Web Reservation' THEN o.total_money ELSE 0 END), 0) AS bowling_web_res,
        COALESCE(SUM(CASE WHEN o.source IN ('Web Reservation-Attraction', 'Multi Attractions Reservation') THEN o.total_money ELSE 0 END), 0) AS laser_tag_web_res
      FROM ${orders} o
      WHERE COALESCE(o.closed_at, o.created_at) BETWEEN ${start} AND ${end}
        AND o.source IN ('Web Reservation', 'Web Reservation-Attraction', 'Multi Attractions Reservation')
        AND o.status IN ('COMPLETED', 'OPEN')
        AND EXISTS (
          SELECT 1 FROM ${orderLineItems} oli
          WHERE oli.order_id = o.id AND oli.name = 'Deposit'
        )
        AND (
          o.status = 'COMPLETED'
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(o.square_data->'tenders') t
            WHERE COALESCE(t->'cardDetails'->>'status', t->>'type') != 'FAILED'
          )
        )
    `);

    const row = result.rows?.[0] ?? { bowling_web_res: '0', laser_tag_web_res: '0' };
    const bowlingWebResDeposits = parseFloat(String(row.bowling_web_res || '0')) || 0;
    const laserTagWebResDeposits = parseFloat(String(row.laser_tag_web_res || '0')) || 0;

    const gcTenderResult = await db.execute<{ total_gc_tender: string }>(sql`
      SELECT COALESCE(SUM(
        ((tender->>'amountMoney')::jsonb->>'amount')::numeric
      ) / 100, 0) AS total_gc_tender
      FROM ${orders} o,
        jsonb_array_elements(o.square_data->'tenders') AS tender
      WHERE COALESCE(o.closed_at, o.created_at) BETWEEN ${start} AND ${end}
        AND o.status IN ('COMPLETED', 'OPEN')
        AND tender->>'type' = 'SQUARE_GIFT_CARD'
    `);
    const totalGcTenderSales = parseFloat(String(gcTenderResult.rows?.[0]?.total_gc_tender || '0')) || 0;
    const giftCardSales = Math.max(0, totalGcTenderSales - bowlingWebResDeposits - laserTagWebResDeposits);

    return {
      bowlingWebResDeposits,
      laserTagWebResDeposits,
      giftCardSales,
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

  async refreshGiftCardBalancesByIds(squareIds: string[]): Promise<{ updated: number; total: number }> {
    if (squareIds.length === 0) return { updated: 0, total: 0 };

    const { fetchGiftCardById } = await import('../squareClient');
    let updated = 0;

    for (const squareId of squareIds) {
      try {
        const card = await fetchGiftCardById(squareId);
        if (!card) continue;

        let balance = 0;
        if (card.balanceMoney?.amount) {
          balance = Number(card.balanceMoney.amount) / 100;
        } else if (card.balance_money?.amount) {
          balance = Number(card.balance_money.amount) / 100;
        }

        const state = card.state || card.status || 'ACTIVE';
        const isActive = state === 'ACTIVE';

        const result = await db.update(giftCards)
          .set({ amount: balance, isActive, updatedAt: new Date() })
          .where(eq(giftCards.squareId, squareId));

        if (result.rowCount && result.rowCount > 0) updated++;
      } catch (err) {
        console.error(`[GiftCardBalanceRefresh] Failed to refresh balance for ${squareId}:`, err);
      }
    }

    console.log(`[GiftCardBalanceRefresh] Refreshed ${updated}/${squareIds.length} card balances`);
    return { updated, total: squareIds.length };
  }

  async refreshAllGiftCardBalances(): Promise<{ updated: number; total: number }> {
    const { fetchGiftCards } = await import('../squareClient');

    console.log('[GiftCardBalanceRefresh] Fetching all gift cards from Square...');
    const allSquareCards = await fetchGiftCards();
    console.log(`[GiftCardBalanceRefresh] Fetched ${allSquareCards.length} cards from Square`);

    const values: { squareId: string; balance: number; isActive: boolean }[] = [];
    for (const card of allSquareCards) {
      const squareId = card.id || card.squareId;
      if (!squareId) continue;

      let balance = 0;
      if (card.balanceMoney?.amount) {
        balance = Number(card.balanceMoney.amount) / 100;
      } else if (card.balance_money?.amount) {
        balance = Number(card.balance_money.amount) / 100;
      }

      const state = card.state || card.status || 'ACTIVE';
      values.push({ squareId, balance, isActive: state === 'ACTIVE' });
    }

    let updated = 0;
    const BATCH = 500;
    for (let i = 0; i < values.length; i += BATCH) {
      const batch = values.slice(i, i + BATCH);
      const valuesChunks = batch.map(v => sql`(${v.squareId}::text, ${v.balance}::real, ${v.isActive}::boolean)`);
      const valuesSql = sql.join(valuesChunks, sql`, `);

      const result = await db.execute(sql`
        UPDATE gift_cards gc SET
          amount = v.balance,
          is_active = v.is_active,
          updated_at = NOW()
        FROM (VALUES ${valuesSql}) AS v(square_id, balance, is_active)
        WHERE gc.square_id = v.square_id
      `);
      updated += result.rowCount ?? 0;
      console.log(`[GiftCardBalanceRefresh] Progress: ${Math.min(i + BATCH, values.length)}/${values.length}`);
    }

    console.log(`[GiftCardBalanceRefresh] Done — updated ${updated} of ${allSquareCards.length} cards`);
    return { updated, total: allSquareCards.length };
  }
}

// Create and export a singleton instance
export const giftCardService = new GiftCardService();