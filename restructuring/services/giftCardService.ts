/**
 * Gift Card Service
 * 
 * Handles business logic related to gift card management
 * Provides a clean interface between API routes and storage layer
 */
import { 
  GiftCard, InsertGiftCard, GiftCardRedemption, InsertGiftCardRedemption,
  Payment, InsertPayment, GiftCardSummary, DateRange
} from '../schema';
import { IStorage } from '../storage';
import { getDateRangeBoundaries } from '../dateUtils';

export class GiftCardError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'GiftCardError';
  }
}

export class GiftCardNotFoundError extends GiftCardError {
  constructor(giftCardId: string | number) {
    super(`Gift card not found: ${giftCardId}`, 'GIFT_CARD_NOT_FOUND');
  }
}

export class InvalidGiftCardDataError extends GiftCardError {
  constructor(message: string, details?: any) {
    super(message, 'INVALID_GIFT_CARD_DATA', details);
  }
}

export class InsufficientBalanceError extends GiftCardError {
  constructor(giftCardId: string | number, requestedAmount: number, currentBalance: number) {
    super(
      `Insufficient balance on gift card: ${giftCardId}. Requested: ${requestedAmount}, Available: ${currentBalance}`,
      'INSUFFICIENT_BALANCE',
      { giftCardId, requestedAmount, currentBalance }
    );
  }
}

export class GiftCardService {
  constructor(private storage: IStorage) {}

  /**
   * Get a gift card by ID with its redemption history
   */
  async getGiftCardWithRedemptions(giftCardId: number): Promise<GiftCard & {
    redemptions: GiftCardRedemption[];
  }> {
    const giftCard = await this.storage.getGiftCard(giftCardId);
    
    if (!giftCard) {
      throw new GiftCardNotFoundError(giftCardId);
    }
    
    const redemptions = await this.storage.getGiftCardRedemptions(giftCardId);
    
    return {
      ...giftCard,
      redemptions
    };
  }
  
  /**
   * Create a new gift card
   */
  async createGiftCard(giftCard: InsertGiftCard): Promise<GiftCard> {
    // Basic validation
    if (!giftCard.squareId || !giftCard.gan) {
      throw new InvalidGiftCardDataError('Gift card requires squareId and GAN');
    }
    
    if (giftCard.activationAmount <= 0) {
      throw new InvalidGiftCardDataError('Gift card activation amount must be positive');
    }
    
    try {
      // Check if a card with this GAN or Square ID already exists
      const existingBySquareId = await this.storage.getGiftCardBySquareId(giftCard.squareId);
      
      if (existingBySquareId) {
        throw new InvalidGiftCardDataError(`Gift card with Square ID ${giftCard.squareId} already exists`);
      }
      
      const existingByGAN = await this.storage.getGiftCardByGAN(giftCard.gan);
      
      if (existingByGAN) {
        throw new InvalidGiftCardDataError(`Gift card with GAN ${giftCard.gan} already exists`);
      }
      
      // Create the gift card
      const createdGiftCard = await this.storage.createGiftCard({
        ...giftCard,
        currentBalance: giftCard.activationAmount,
        redeemedAmount: 0,
        isActive: true,
        createdAt: new Date(),
        activatedAt: new Date()
      });
      
      return createdGiftCard;
    } catch (error) {
      // Log the error
      console.error('Failed to create gift card:', error);
      
      // Rethrow with appropriate error class
      if (error instanceof GiftCardError) {
        throw error;
      }
      
      throw new GiftCardError(
        'Failed to create gift card',
        'GIFT_CARD_CREATION_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  
  /**
   * Process a gift card redemption
   */
  async processRedemption(
    giftCardId: number,
    paymentId: number,
    amount: number,
    orderId?: number
  ): Promise<GiftCardRedemption> {
    // Validate the gift card
    const giftCard = await this.storage.getGiftCard(giftCardId);
    
    if (!giftCard) {
      throw new GiftCardNotFoundError(giftCardId);
    }
    
    if (!giftCard.isActive) {
      throw new GiftCardError('Gift card is not active', 'INACTIVE_GIFT_CARD');
    }
    
    if (amount <= 0) {
      throw new InvalidGiftCardDataError('Redemption amount must be positive');
    }
    
    if (amount > giftCard.currentBalance) {
      throw new InsufficientBalanceError(giftCardId, amount, giftCard.currentBalance);
    }
    
    try {
      // Update gift card balance
      await this.storage.updateGiftCard(giftCardId, {
        currentBalance: giftCard.currentBalance - amount,
        redeemedAmount: giftCard.redeemedAmount + amount
      });
      
      // Create redemption record
      const redemption = await this.storage.createGiftCardRedemption({
        giftCardId,
        paymentId,
        orderId,
        amount,
        timestamp: new Date()
      });
      
      return redemption;
    } catch (error) {
      // Log the error
      console.error('Failed to process gift card redemption:', error);
      
      // Rethrow with appropriate error class
      if (error instanceof GiftCardError) {
        throw error;
      }
      
      throw new GiftCardError(
        'Failed to process gift card redemption',
        'REDEMPTION_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  
  /**
   * Get a summary of gift card activity for the specified date range
   */
  async getGiftCardSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<GiftCardSummary> {
    // Normalize date range
    const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
    
    // Delegate to storage layer
    return this.storage.getGiftCardSummary(dateRange, start, end);
  }
  
  /**
   * Get total gift card sales for the specified date range
   */
  async getGiftCardSales(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<number> {
    // Normalize date range
    const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
    
    // Delegate to storage layer
    return this.storage.getGiftCardSales(dateRange, start, end);
  }
}