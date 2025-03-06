/**
 * Order Service Tests
 * 
 * Unit tests for OrderService functionality
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderService, OrderNotFoundError, InvalidOrderDataError } from '../services/orderService';
import { Order, InsertOrder, OrderLineItem, OrderDiscount } from '../schema';

// Mock storage
const mockStorage = {
  getOrder: vi.fn(),
  getOrderBySquareId: vi.fn(),
  listOrdersByDateRange: vi.fn(),
  createOrder: vi.fn(),
  updateOrder: vi.fn(),
  deleteOrder: vi.fn(),
  getOrderItems: vi.fn(),
  getLineItem: vi.fn(),
  createOrderItem: vi.fn(),
  updateOrderItem: vi.fn(),
  deleteOrderItem: vi.fn(),
  getOrderModifiers: vi.fn(),
  createOrderModifier: vi.fn(),
  getOrderDiscounts: vi.fn(),
  createOrderDiscount: vi.fn(),
  getOrderSummary: vi.fn()
};

// Create the service with mock storage
const orderService = new OrderService(mockStorage as any);

describe('OrderService', () => {
  // Reset mocks before each test
  beforeEach(() => {
    vi.resetAllMocks();
  });
  
  describe('getOrderWithDetails', () => {
    it('should get an order with all its details', async () => {
      // Mock order data
      const mockOrder: Order = {
        id: 1,
        squareId: 'sq_1',
        status: 'COMPLETED',
        totalMoney: 100,
        totalTax: 10,
        totalDiscount: 5,
        createdAt: new Date(),
        closedAt: new Date(),
        source: 'square',
        isDeleted: false,
        squareData: {}
      };
      
      // Mock line items
      const mockItems: OrderLineItem[] = [
        {
          id: 1,
          orderId: 1,
          name: 'Test Item',
          quantity: 2,
          totalMoney: 50,
          basePriceMoney: 25,
          productId: 'prod_1',
          isGiftCard: false,
          category: 'food',
          squareData: {}
        }
      ];
      
      // Mock discounts
      const mockDiscounts: OrderDiscount[] = [
        {
          id: 1,
          orderId: 1,
          name: 'Test Discount',
          amount: 5,
          percentage: 10,
          scope: 'ORDER',
          targetId: null,
          squareData: {}
        }
      ];
      
      // Mock modifiers
      const mockModifiers = [
        {
          id: 1,
          lineItemId: 1,
          name: 'Extra',
          priceMoney: 2,
          squareData: {}
        }
      ];
      
      // Setup mocks
      mockStorage.getOrder.mockResolvedValue(mockOrder);
      mockStorage.getOrderItems.mockResolvedValue(mockItems);
      mockStorage.getOrderDiscounts.mockResolvedValue(mockDiscounts);
      mockStorage.getOrderModifiers.mockResolvedValue(mockModifiers);
      
      // Call the service
      const result = await orderService.getOrderWithDetails(1);
      
      // Verify calls
      expect(mockStorage.getOrder).toHaveBeenCalledWith(1);
      expect(mockStorage.getOrderItems).toHaveBeenCalledWith(1);
      expect(mockStorage.getOrderDiscounts).toHaveBeenCalledWith(1);
      expect(mockStorage.getOrderModifiers).toHaveBeenCalledWith(1);
      
      // Verify result
      expect(result).toEqual({
        ...mockOrder,
        items: [{ ...mockItems[0], modifiers: mockModifiers }],
        discounts: mockDiscounts
      });
    });
    
    it('should throw OrderNotFoundError if order does not exist', async () => {
      // Setup mock to return null
      mockStorage.getOrder.mockResolvedValue(undefined);
      
      // Expect the service to throw
      await expect(orderService.getOrderWithDetails(999))
        .rejects
        .toThrow(OrderNotFoundError);
    });
  });
  
  describe('createCompleteOrder', () => {
    it('should create an order with items and discounts', async () => {
      // Mock order data
      const mockOrderData: InsertOrder = {
        squareId: 'sq_2',
        status: 'PENDING',
        totalMoney: 100,
        totalTax: 10,
        totalDiscount: 5,
        closedAt: null,
        source: 'square',
        isDeleted: false,
        squareData: {}
      };
      
      // Mock created order
      const mockCreatedOrder: Order = {
        ...mockOrderData,
        id: 2,
        createdAt: new Date()
      };
      
      // Mock item data
      const mockItemData = [
        {
          name: 'Test Item',
          quantity: 2,
          totalMoney: 50,
          basePriceMoney: 25,
          productId: 'prod_1',
          isGiftCard: false,
          category: 'food',
          squareData: {},
          modifiers: [
            {
              name: 'Extra',
              priceMoney: 2,
              squareData: {}
            }
          ]
        }
      ];
      
      // Mock discount data
      const mockDiscountData = [
        {
          name: 'Test Discount',
          amount: 5,
          percentage: 10,
          scope: 'ORDER',
          squareData: {}
        }
      ];
      
      // Mock created item
      const mockCreatedItem = {
        id: 2,
        orderId: 2,
        name: 'Test Item',
        quantity: 2,
        totalMoney: 50,
        basePriceMoney: 25,
        productId: 'prod_1',
        isGiftCard: false,
        category: 'food',
        squareData: {}
      };
      
      // Setup mocks
      mockStorage.createOrder.mockResolvedValue(mockCreatedOrder);
      mockStorage.createOrderItem.mockResolvedValue(mockCreatedItem);
      mockStorage.createOrderModifier.mockResolvedValue({
        id: 2,
        lineItemId: 2,
        name: 'Extra',
        priceMoney: 2,
        squareData: {}
      });
      mockStorage.createOrderDiscount.mockResolvedValue({
        id: 2,
        orderId: 2,
        name: 'Test Discount',
        amount: 5,
        percentage: 10,
        scope: 'ORDER',
        targetId: null,
        squareData: {}
      });
      
      // Call the service
      const result = await orderService.createCompleteOrder(
        mockOrderData,
        mockItemData as any,
        mockDiscountData as any
      );
      
      // Verify calls
      expect(mockStorage.createOrder).toHaveBeenCalledWith(mockOrderData);
      expect(mockStorage.createOrderItem).toHaveBeenCalledTimes(1);
      expect(mockStorage.createOrderModifier).toHaveBeenCalledTimes(1);
      expect(mockStorage.createOrderDiscount).toHaveBeenCalledTimes(1);
      
      // Verify result
      expect(result).toEqual(mockCreatedOrder);
    });
    
    it('should validate order data', async () => {
      // Invalid order - missing squareId
      const invalidOrder = {
        status: 'PENDING',
        totalMoney: 100
      };
      
      // Expect validation error
      await expect(orderService.createCompleteOrder(
        invalidOrder as any,
        [{ name: 'Item', totalMoney: 50 }] as any
      )).rejects.toThrow(InvalidOrderDataError);
      
      // Expect no storage calls
      expect(mockStorage.createOrder).not.toHaveBeenCalled();
    });
    
    it('should validate items array', async () => {
      // Valid order but no items
      const order = {
        squareId: 'sq_3',
        status: 'PENDING',
        totalMoney: 100
      };
      
      // Expect validation error
      await expect(orderService.createCompleteOrder(
        order as any,
        [] // Empty items array
      )).rejects.toThrow(InvalidOrderDataError);
      
      // Expect no storage calls
      expect(mockStorage.createOrder).not.toHaveBeenCalled();
    });
  });
  
  describe('getOrderSummary', () => {
    it('should return order summary for a date range', async () => {
      // Mock summary
      const mockSummary = {
        totalOrders: 10,
        totalRevenue: 1000,
        averageOrderValue: 100,
        itemsSold: 50,
        topSellingItems: [
          { name: 'Item 1', quantity: 20, revenue: 500 }
        ],
        discountTotal: 50,
        taxTotal: 80
      };
      
      // Setup mock
      mockStorage.getOrderSummary.mockResolvedValue(mockSummary);
      
      // Call the service
      const result = await orderService.getOrderSummary('today');
      
      // Verify the call
      expect(mockStorage.getOrderSummary).toHaveBeenCalledWith('today', expect.any(Date), expect.any(Date));
      
      // Verify result
      expect(result).toEqual(mockSummary);
    });
  });
});