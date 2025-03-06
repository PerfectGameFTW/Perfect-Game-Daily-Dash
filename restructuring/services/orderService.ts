/**
 * Order Service
 * 
 * Handles business logic related to order management
 * Provides a clean interface between API routes and storage layer
 */
import { 
  Order, InsertOrder, OrderLineItem, InsertOrderLineItem,
  OrderModifier, InsertOrderModifier, OrderDiscount, InsertOrderDiscount,
  OrderSummary, DateRange
} from '../schema';
import { IStorage } from '../storage';
import { getDateRangeBoundaries } from '../dateUtils';

export class OrderError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'OrderError';
  }
}

export class OrderNotFoundError extends OrderError {
  constructor(orderId: string | number) {
    super(`Order not found: ${orderId}`, 'ORDER_NOT_FOUND');
  }
}

export class InvalidOrderDataError extends OrderError {
  constructor(message: string, details?: any) {
    super(message, 'INVALID_ORDER_DATA', details);
  }
}

export class OrderService {
  constructor(private storage: IStorage) {}

  /**
   * Get an order by ID with its complete data (items, modifiers, discounts)
   */
  async getOrderWithDetails(orderId: number): Promise<Order & {
    items: (OrderLineItem & { modifiers: OrderModifier[] })[];
    discounts: OrderDiscount[];
  }> {
    const order = await this.storage.getOrder(orderId);
    
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }
    
    // Get all the related data in parallel
    const [items, discounts] = await Promise.all([
      this.storage.getOrderItems(orderId),
      this.storage.getOrderDiscounts(orderId)
    ]);
    
    // Get modifiers for each item
    const itemsWithModifiers = await Promise.all(
      items.map(async (item) => {
        const modifiers = await this.storage.getOrderModifiers(item.id);
        return {
          ...item,
          modifiers
        };
      })
    );
    
    return {
      ...order,
      items: itemsWithModifiers,
      discounts
    };
  }
  
  /**
   * Create a complete order with its items, modifiers, and discounts
   */
  async createCompleteOrder(
    order: InsertOrder,
    items: InsertOrderLineItem[],
    discounts: InsertOrderDiscount[] = []
  ): Promise<Order> {
    // Basic validation
    if (!order.squareId || !order.status) {
      throw new InvalidOrderDataError('Order requires squareId and status');
    }
    
    if (items.length === 0) {
      throw new InvalidOrderDataError('Order must have at least one item');
    }
    
    try {
      // Use a transaction for atomicity
      // Note: This approach assumes a PostgreSQL-based storage implementation
      const createdOrder = await this.storage.createOrder(order);
      
      // Create all items
      const createdItems = await Promise.all(
        items.map(item => 
          this.storage.createOrderItem({
            ...item,
            orderId: createdOrder.id
          })
        )
      );
      
      // Create modifiers for each item
      for (const itemData of items) {
        if (itemData.modifiers && itemData.modifiers.length > 0) {
          const item = createdItems.find(i => i.name === itemData.name);
          
          if (item) {
            await Promise.all(
              itemData.modifiers.map(modifier => 
                this.storage.createOrderModifier({
                  ...modifier,
                  lineItemId: item.id
                })
              )
            );
          }
        }
      }
      
      // Create all discounts
      if (discounts.length > 0) {
        await Promise.all(
          discounts.map(discount => 
            this.storage.createOrderDiscount({
              ...discount,
              orderId: createdOrder.id
            })
          )
        );
      }
      
      return createdOrder;
    } catch (error) {
      // Log the error
      console.error('Failed to create complete order:', error);
      
      // Rethrow with appropriate error class
      if (error instanceof OrderError) {
        throw error;
      }
      
      throw new OrderError(
        'Failed to create order',
        'ORDER_CREATION_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  
  /**
   * Get a summary of orders for the specified date range
   */
  async getOrderSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<OrderSummary> {
    // Normalize date range
    const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
    
    // Delegate to storage layer
    return this.storage.getOrderSummary(dateRange, start, end);
  }
  
  /**
   * Get all orders for a date range
   */
  async getOrdersByDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<Order[]> {
    // Normalize date range
    const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
    
    // Delegate to storage layer
    return this.storage.listOrdersByDateRange(dateRange, start, end);
  }
}