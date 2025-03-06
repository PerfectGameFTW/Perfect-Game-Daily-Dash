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
        .limit(1)
        .forUpdate();
      
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
      
      const updatedCard = await tx.update(giftCards)
        .set({
          amount: newBalance,
          redeemedAmount: newRedeemedAmount,
          lastRedemptionDate: new Date(),
          updatedAt: new Date()
        })
        .where(eq(giftCards.id, giftCardId))
        .returning();
      
      if (!updatedCard.length) {
        throw new GiftCardError('Failed to update gift card balance', 'DB_ERROR');
      }
      
      // Create redemption record
      const redemptionData: InsertGiftCardRedemption = {
        giftCardId,
        amount,
        timestamp: new Date(),
        paymentId: paymentId || null,
        orderId: orderId || null,
        squareData: {}
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
    
    // Query the database for gift card activations
    const activationsResult = await db.select({
      soldCount: sql<number>`COUNT(*)`,
      soldAmount: sql<number>`COALESCE(SUM(${giftCards.activationAmount}), 0)`
    }).from(giftCards)
      .where(
        and(
          between(giftCards.createdAt, start, end),
          gt(giftCards.activationAmount, 0)
        )
      );
    
    // Query the database for gift card redemptions
    const redemptionsResult = await db.select({
      redeemedCount: sql<number>`COUNT(*)`,
      redeemedAmount: sql<number>`COALESCE(SUM(${giftCardRedemptions.amount}), 0)`
    }).from(giftCardRedemptions)
      .where(between(giftCardRedemptions.timestamp, start, end));
    
    const soldCount = activationsResult[0]?.soldCount || 0;
    const soldAmount = activationsResult[0]?.soldAmount || 0;
    const redeemedCount = redemptionsResult[0]?.redeemedCount || 0;
    const redeemedAmount = redemptionsResult[0]?.redeemedAmount || 0;
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
    
    // Query the database for gift card sales
    const result = await db.execute<{ gift_card_sales: number, gift_card_count: number }>(sql`
      SELECT 
        COALESCE(SUM(${giftCards.activationAmount}), 0) as gift_card_sales,
        COUNT(*) as gift_card_count
      FROM ${giftCards}
      WHERE ${giftCards.createdAt} BETWEEN ${start} AND ${end}
        AND ${giftCards.activationAmount} > 0
    `);
    
    // Access the result properly from the raw SQL query result
    const giftCardSales = result.rows?.[0]?.gift_card_sales || 0;
    const giftCardCount = result.rows?.[0]?.gift_card_count || 0;
    
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
    const result = await db.execute(sql`
      UPDATE ${giftCards} gc
      SET 
        ${giftCards.activationAmount} = GREATEST(
          COALESCE(${giftCards.amount}, 0) + COALESCE(${giftCards.redeemedAmount}, 0),
          COALESCE((
            SELECT ${transactions.amount}
            FROM ${transactions}
            WHERE ${transactions.giftCardId} = ${giftCards.id}
              AND ${transactions.status} = 'completed'
            ORDER BY ${transactions.timestamp}
            LIMIT 1
          ), 0)
        )
      WHERE 
        (${giftCards.activationAmount} IS NULL OR ${giftCards.activationAmount} = 0)
        AND ${giftCards.isActive} = TRUE
    `);
    
    return result.rowCount || 0;
  }
}

// Create and export a singleton instance
export const giftCardService = new GiftCardService();