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
   * Create a new gift card
   * 
   * @param giftCardData The gift card data to insert
   * @returns The created gift card
   */
  async createGiftCard(giftCardData: InsertGiftCard): Promise<GiftCard> {
    const result = await db.insert(giftCards).values(giftCardData).returning();
    
    if (!result.length) {
      throw new GiftCardError('Failed to create gift card', 'DB_ERROR');
    }
    
    return result[0];
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
    
    console.log(`Getting gift card summary with UTC dates: ${start.toISOString()} to ${end.toISOString()}`);
    
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
    
    // Query the database for gift card redemptions using Drizzle's SQL template
    // which properly handles parameterized queries
    const redemptionsResult = await db.execute(sql`
      SELECT 
        COUNT(*) as redeemed_count,
        COALESCE(SUM(amount), 0) as redeemed_amount
      FROM gift_card_redemptions
      WHERE timestamp BETWEEN ${start} AND ${end}
    `);
    
    // Access the result properly from the raw SQL query results
    // Convert all values to numbers to avoid type issues
    const soldCount = parseInt(String(activationsResult.rows?.[0]?.sold_count || '0'), 10) || 0;
    const soldAmount = parseFloat(String(activationsResult.rows?.[0]?.sold_amount || '0')) || 0;
    const redeemedCount = parseInt(String(redemptionsResult.rows?.[0]?.redeemed_count || '0'), 10) || 0;
    const redeemedAmount = parseFloat(String(redemptionsResult.rows?.[0]?.redeemed_amount || '0')) || 0;
    const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;
    
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
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    console.log(`Getting gift card sales with UTC dates: {
  dateRange: '${dateRange}',
  startUTC: '${start.toISOString()}',
  endUTC: '${end.toISOString()}',
  startDate: ${startDate ? `'${startDate.toISOString()}'` : 'undefined'},
  endDate: ${endDate ? `'${endDate.toISOString()}'` : 'undefined'}
}`);
    
    // Query the database for gift card sales using Drizzle's SQL template
    // which properly handles parameterized queries
    const result = await db.execute(sql`
      SELECT 
        COALESCE(SUM(activation_amount), 0) as gift_card_sales,
        COUNT(*) as gift_card_count
      FROM gift_cards
      WHERE purchase_date BETWEEN ${start} AND ${end}
        AND activation_amount > 0
    `);
    
    // Access the result properly from the raw SQL query result with proper type conversion
    const giftCardSales = parseFloat(String(result.rows?.[0]?.gift_card_sales || '0')) || 0;
    const giftCardCount = parseInt(String(result.rows?.[0]?.gift_card_count || '0'), 10) || 0;
    
    console.log(`Gift card sales calculated from database using UTC: {
  dateRange: '${dateRange}',
  giftCardSales: ${giftCardSales},
  giftCardCount: ${giftCardCount},
  dateRangeStr: '${start.toISOString()} to ${end.toISOString()}'
}`);
    
    return giftCardSales;
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
   * @returns Number of fixed gift cards
   */
  async fixGiftCardActivationAmounts(): Promise<number> {
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
        )
      WHERE 
        (gc.activation_amount IS NULL OR gc.activation_amount = 0)
        AND gc.is_active = TRUE
    `);
    
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