/**
 * Gift Card Service Tests
 * 
 * Unit tests for GiftCardService functionality
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GiftCardService, GiftCardNotFoundError, InsufficientBalanceError } from '../services/giftCardService';
import { GiftCard, InsertGiftCard, GiftCardRedemption } from '../schema';

// Mock storage
const mockStorage = {
  getGiftCard: vi.fn(),
  getGiftCardBySquareId: vi.fn(),
  getGiftCardByGAN: vi.fn(),
  listGiftCards: vi.fn(),
  createGiftCard: vi.fn(),
  updateGiftCard: vi.fn(),
  getGiftCardRedemptions: vi.fn(),
  createGiftCardRedemption: vi.fn(),
  getGiftCardSummary: vi.fn(),
  getGiftCardSales: vi.fn()
};

// Create the service with mock storage
const giftCardService = new GiftCardService(mockStorage as any);

describe('GiftCardService', () => {
  // Reset mocks before each test
  beforeEach(() => {
    vi.resetAllMocks();
  });
  
  describe('getGiftCardWithRedemptions', () => {
    it('should get a gift card with its redemption history', async () => {
      // Mock gift card data
      const mockGiftCard: GiftCard = {
        id: 1,
        squareId: 'gc_1',
        gan: '1234567890',
        state: 'ACTIVE',
        balance: 50,
        activationAmount: 100,
        createdAt: new Date(),
        purchasedAt: new Date(),
        redeemed: 50,
        squareData: {}
      };
      
      // Mock redemptions
      const mockRedemptions: GiftCardRedemption[] = [
        {
          id: 1,
          giftCardId: 1,
          amount: 30,
          timestamp: new Date(),
          paymentId: 1,
          squareData: {}
        },
        {
          id: 2,
          giftCardId: 1,
          amount: 20,
          timestamp: new Date(),
          paymentId: 2,
          squareData: {}
        }
      ];
      
      // Setup mocks
      mockStorage.getGiftCard.mockResolvedValue(mockGiftCard);
      mockStorage.getGiftCardRedemptions.mockResolvedValue(mockRedemptions);
      
      // Call the service
      const result = await giftCardService.getGiftCardWithRedemptions(1);
      
      // Verify calls
      expect(mockStorage.getGiftCard).toHaveBeenCalledWith(1);
      expect(mockStorage.getGiftCardRedemptions).toHaveBeenCalledWith(1);
      
      // Verify result
      expect(result).toEqual({
        ...mockGiftCard,
        redemptions: mockRedemptions
      });
    });
    
    it('should throw GiftCardNotFoundError if gift card does not exist', async () => {
      // Setup mock to return null
      mockStorage.getGiftCard.mockResolvedValue(undefined);
      
      // Expect the service to throw
      await expect(giftCardService.getGiftCardWithRedemptions(999))
        .rejects
        .toThrow(GiftCardNotFoundError);
    });
  });
  
  describe('createGiftCard', () => {
    it('should create a new gift card', async () => {
      // Mock gift card data
      const mockGiftCardData: InsertGiftCard = {
        squareId: 'gc_2',
        gan: '0987654321',
        state: 'ACTIVE',
        balance: 100,
        activationAmount: 100,
        purchasedAt: new Date(),
        redeemed: 0,
        squareData: {}
      };
      
      // Mock created gift card
      const mockCreatedGiftCard: GiftCard = {
        ...mockGiftCardData,
        id: 2,
        createdAt: new Date()
      };
      
      // Setup mock
      mockStorage.createGiftCard.mockResolvedValue(mockCreatedGiftCard);
      
      // Call the service
      const result = await giftCardService.createGiftCard(mockGiftCardData);
      
      // Verify call
      expect(mockStorage.createGiftCard).toHaveBeenCalledWith(mockGiftCardData);
      
      // Verify result
      expect(result).toEqual(mockCreatedGiftCard);
    });
  });
  
  describe('processRedemption', () => {
    it('should process a successful gift card redemption', async () => {
      // Mock gift card data
      const mockGiftCard: GiftCard = {
        id: 3,
        squareId: 'gc_3',
        gan: '1357924680',
        state: 'ACTIVE',
        balance: 100,
        activationAmount: 100,
        createdAt: new Date(),
        purchasedAt: new Date(),
        redeemed: 0,
        squareData: {}
      };
      
      // Mock redemption data
      const redemptionAmount = 50;
      const paymentId = 5;
      
      // Mock updated gift card data (after redemption)
      const mockUpdatedGiftCard: GiftCard = {
        ...mockGiftCard,
        balance: 50,
        redeemed: 50
      };
      
      // Mock created redemption
      const mockCreatedRedemption: GiftCardRedemption = {
        id: 3,
        giftCardId: 3,
        amount: 50,
        timestamp: expect.any(Date),
        paymentId: 5,
        squareData: {}
      };
      
      // Setup mocks
      mockStorage.getGiftCard.mockResolvedValue(mockGiftCard);
      mockStorage.updateGiftCard.mockResolvedValue(mockUpdatedGiftCard);
      mockStorage.createGiftCardRedemption.mockResolvedValue(mockCreatedRedemption);
      
      // Call the service
      const result = await giftCardService.processRedemption(3, redemptionAmount, paymentId);
      
      // Verify calls
      expect(mockStorage.getGiftCard).toHaveBeenCalledWith(3);
      expect(mockStorage.updateGiftCard).toHaveBeenCalledWith(3, {
        balance: 50,
        redeemed: 50
      });
      expect(mockStorage.createGiftCardRedemption).toHaveBeenCalledWith({
        giftCardId: 3,
        amount: 50,
        timestamp: expect.any(Date),
        paymentId: 5,
        squareData: {}
      });
      
      // Verify result
      expect(result).toEqual({
        success: true,
        giftCard: mockUpdatedGiftCard,
        redemption: mockCreatedRedemption
      });
    });
    
    it('should throw GiftCardNotFoundError if gift card does not exist', async () => {
      // Setup mock to return null
      mockStorage.getGiftCard.mockResolvedValue(undefined);
      
      // Expect the service to throw
      await expect(giftCardService.processRedemption(999, 50, 5))
        .rejects
        .toThrow(GiftCardNotFoundError);
    });
    
    it('should throw InsufficientBalanceError if redemption amount exceeds balance', async () => {
      // Mock gift card with low balance
      const mockGiftCard: GiftCard = {
        id: 4,
        squareId: 'gc_4',
        gan: '2468135790',
        state: 'ACTIVE',
        balance: 25,
        activationAmount: 100,
        createdAt: new Date(),
        purchasedAt: new Date(),
        redeemed: 75,
        squareData: {}
      };
      
      // Setup mock
      mockStorage.getGiftCard.mockResolvedValue(mockGiftCard);
      
      // Expect the service to throw
      await expect(giftCardService.processRedemption(4, 50, 5))
        .rejects
        .toThrow(InsufficientBalanceError);
      
      // Verify no update was attempted
      expect(mockStorage.updateGiftCard).not.toHaveBeenCalled();
      expect(mockStorage.createGiftCardRedemption).not.toHaveBeenCalled();
    });
  });
  
  describe('getGiftCardSummary', () => {
    it('should return gift card summary for a date range', async () => {
      // Mock summary
      const mockSummary = {
        soldCount: 10,
        soldAmount: 1000,
        redeemedCount: 5,
        redeemedAmount: 250,
        averageValue: 100
      };
      
      // Setup mock
      mockStorage.getGiftCardSummary.mockResolvedValue(mockSummary);
      
      // Call the service
      const result = await giftCardService.getGiftCardSummary('today');
      
      // Verify the call
      expect(mockStorage.getGiftCardSummary).toHaveBeenCalledWith('today', expect.any(Date), expect.any(Date));
      
      // Verify result
      expect(result).toEqual(mockSummary);
    });
  });
  
  describe('getGiftCardSales', () => {
    it('should return gift card sales for a date range', async () => {
      // Mock sales amount
      const mockSalesAmount = 500;
      
      // Setup mock
      mockStorage.getGiftCardSales.mockResolvedValue(mockSalesAmount);
      
      // Call the service
      const result = await giftCardService.getGiftCardSales('today');
      
      // Verify the call
      expect(mockStorage.getGiftCardSales).toHaveBeenCalledWith('today', expect.any(Date), expect.any(Date));
      
      // Verify result
      expect(result).toEqual(mockSalesAmount);
    });
  });
});