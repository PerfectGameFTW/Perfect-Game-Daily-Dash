/**
 * Order Service
 * 
 * Handles all order-related business logic with proper error handling
 * and data validation. Provides a clean API for the rest of the application.
 */

import { db } from '../db';
import { eq, and, between, desc, asc, sql, isNull, gt, count, sum, inArray } from 'drizzle-orm';
import { 
  orders,
  orderLineItems,
  orderModifiers,
  orderDiscounts,
  type Order,
  type InsertOrder,
  type OrderLineItem,
  type InsertOrderLineItem,
  type OrderModifier,
  type InsertOrderModifier,
  type OrderDiscount,
  type InsertOrderDiscount,
  type DateRange,
  type OrderSummary,
  type CategoryRevenue,
  type HourlyRevenue
} from '../../shared/schema';
import { getEasternDateRange } from '../dateUtils';

export class OrderError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'OrderError';
  }
}

export class OrderNotFoundError extends OrderError {
  constructor(orderId: string | number) {
    super(`Order with ID ${orderId} not found`, 'ORDER_NOT_FOUND');
    this.name = 'OrderNotFoundError';
  }
}

export class InvalidOrderDataError extends OrderError {
  constructor(message: string, details?: any) {
    super(message, 'INVALID_ORDER_DATA', details);
    this.name = 'InvalidOrderDataError';
  }
}

export class OrderService {
  /**
   * Get an order by ID
   * 
   * @param id The order ID
   * @returns The order or throws if not found
   */
  async getOrderById(id: number): Promise<Order> {
    const result = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    
    if (!result.length) {
      throw new OrderNotFoundError(id);
    }
    
    return result[0];
  }
  
  /**
   * Get an order by Square ID
   * 
   * @param squareId The Square order ID
   * @returns The order or throws if not found
   */
  async getOrderBySquareId(squareId: string): Promise<Order> {
    const result = await db.select().from(orders).where(eq(orders.squareId, squareId)).limit(1);
    
    if (!result.length) {
      throw new OrderNotFoundError(squareId);
    }
    
    return result[0];
  }
  
  /**
   * Create a new order
   * 
   * @param orderData The order data to insert
   * @returns The created order
   */
  async createOrder(orderData: InsertOrder): Promise<Order> {
    const result = await db.insert(orders).values(orderData).returning();
    
    if (!result.length) {
      throw new OrderError('Failed to create order', 'DB_ERROR');
    }
    
    return result[0];
  }

  async updateOrderBySquareId(squareId: string, orderData: Partial<InsertOrder>): Promise<Order | null> {
    const result = await db.update(orders)
      .set(orderData)
      .where(eq(orders.squareId, squareId))
      .returning();
    return result.length ? result[0] : null;
  }
  
  /**
   * Get order items for an order
   * 
   * @param orderId The order ID
   * @returns Array of order items
   */
  async getOrderItems(orderId: number): Promise<OrderLineItem[]> {
    return await db.select().from(orderLineItems)
      .where(eq(orderLineItems.orderId, orderId))
      .orderBy(asc(orderLineItems.id));
  }
  
  /**
   * Create an order line item
   * 
   * @param itemData The line item data to insert
   * @returns The created line item
   */
  async createOrderItem(itemData: InsertOrderLineItem): Promise<OrderLineItem> {
    const result = await db.insert(orderLineItems).values(itemData).returning();
    
    if (!result.length) {
      throw new OrderError('Failed to create order item', 'DB_ERROR');
    }
    
    return result[0];
  }
  
  /**
   * Create a complete order with items, modifiers, and discounts
   * 
   * @param orderData The order data
   * @param items The order line items
   * @param discounts The order discounts
   * @returns The created order
   */
  async createCompleteOrder(
    orderData: InsertOrder,
    items: Omit<InsertOrderLineItem, 'orderId'>[],
    discounts: Omit<InsertOrderDiscount, 'orderId'>[] = []
  ): Promise<Order> {
    return await db.transaction(async (tx) => {
      // Create the order
      const orderResult = await tx.insert(orders).values(orderData).returning();
      
      if (!orderResult.length) {
        throw new OrderError('Failed to create order', 'DB_ERROR');
      }
      
      const order = orderResult[0];
      
      // Create order items
      for (const item of items) {
        const itemData: InsertOrderLineItem = {
          ...item,
          orderId: order.id
        };
        
        const itemResult = await tx.insert(orderLineItems).values(itemData).returning();
        
        if (!itemResult.length) {
          throw new OrderError('Failed to create order item', 'DB_ERROR');
        }
      }
      
      // Create order discounts
      for (const discount of discounts) {
        const discountData: InsertOrderDiscount = {
          ...discount,
          orderId: order.id
        };
        
        const discountResult = await tx.insert(orderDiscounts).values(discountData).returning();
        
        if (!discountResult.length) {
          throw new OrderError('Failed to create order discount', 'DB_ERROR');
        }
      }
      
      return order;
    });
  }
  
  /**
   * Get orders by date range with proper timezone handling
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @param limit Optional result limit
   * @returns Array of orders in the specified date range
   */
  async getOrdersByDateRange(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date,
    limit?: number
  ): Promise<Order[]> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    const effectiveDate = sql`COALESCE(${orders.closedAt}, ${orders.createdAt})`;
    const baseQuery = db.select().from(orders)
      .where(and(
        sql`${effectiveDate} BETWEEN ${start} AND ${end}`,
        inArray(orders.status, ['COMPLETED', 'OPEN'])
      ))
      .orderBy(desc(sql`COALESCE(${orders.closedAt}, ${orders.createdAt})`));
    
    return await (limit && limit > 0 ? baseQuery.limit(limit) : baseQuery);
  }
  
  /**
   * Get order summary for a date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Order summary with aggregate data
   */
  async getOrderSummary(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<OrderSummary> {
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    const effectiveDate = sql`COALESCE(${orders.closedAt}, ${orders.createdAt})`;
    const dateAndStatusFilter = and(
      sql`${effectiveDate} BETWEEN ${start} AND ${end}`,
      inArray(orders.status, ['COMPLETED', 'OPEN'])
    );

    const summaryResult = await db.select({
      totalOrders: count(orders.id),
      totalRevenue: sql<number>`COALESCE(SUM(${orders.totalMoney}), 0)`,
      taxTotal: sql<number>`COALESCE(SUM(${orders.totalTax}), 0)`,
      discountTotal: sql<number>`COALESCE(SUM(${orders.totalDiscount}), 0)`
    }).from(orders)
      .where(dateAndStatusFilter);
    
    const itemsResult = await db.select({
      itemsSold: count(orderLineItems.id),
    }).from(orderLineItems)
      .innerJoin(orders, eq(orderLineItems.orderId, orders.id))
      .where(dateAndStatusFilter);
    
    const topSellingItemsResult = await db.select({
      name: orderLineItems.name,
      quantity: sql<number>`COALESCE(SUM(${orderLineItems.quantity}), 0)`,
      revenue: sql<number>`COALESCE(SUM(${orderLineItems.totalMoney}), 0)`
    }).from(orderLineItems)
      .innerJoin(orders, eq(orderLineItems.orderId, orders.id))
      .where(dateAndStatusFilter)
      .groupBy(orderLineItems.name)
      .orderBy(desc(sql`revenue`))
      .limit(5);
    
    const totalOrders = summaryResult[0]?.totalOrders || 0;
    const totalRevenue = summaryResult[0]?.totalRevenue || 0;
    const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const itemsSold = itemsResult[0]?.itemsSold || 0;
    const taxTotal = summaryResult[0]?.taxTotal || 0;
    const discountTotal = summaryResult[0]?.discountTotal || 0;
    
    return {
      totalOrders,
      totalRevenue,
      averageOrderValue,
      itemsSold,
      topSellingItems: topSellingItemsResult,
      discountTotal,
      taxTotal
    };
  }
  
  /**
   * Get category revenue for a date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Array of category revenue data with colors
   */
  async getCategoryRevenue(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<CategoryRevenue[]> {
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    const result = await db.execute<{ category: string, sum_amount: number }>(sql`
      SELECT 
        ${orderLineItems.category} as category,
        COALESCE(SUM(${orderLineItems.totalMoney}), 0) as sum_amount
      FROM ${orderLineItems}
      INNER JOIN ${orders} ON ${orderLineItems.orderId} = ${orders.id}
      WHERE COALESCE(${orders.closedAt}, ${orders.createdAt}) BETWEEN ${start} AND ${end}
        AND ${orders.status} IN ('COMPLETED', 'OPEN')
      GROUP BY ${orderLineItems.category}
      ORDER BY sum_amount DESC
    `);
    
    // Category colors mapping
    const colorMap: Record<string, string> = {
      food: '#FF6B6B',
      beverage: '#4ECDC4',
      alcohol: '#7367F0',
      retail: '#FFC75F',
      other: '#845EC2',
      event: '#00C9A7',
      rental: '#F9F871',
      service: '#C4FCEF',
      tripleseat: '#FF9671',
      partywirks: '#D65DB1',
      giftCard: '#19647E'
    };
    
    // Default color
    const defaultColor = '#999999';
    
    // Map the results to include colors
    // Since we're using raw SQL with execute, we need to access rows
    return (result.rows || []).map(item => ({
      category: item.category || 'other',
      amount: item.sum_amount,
      color: colorMap[item.category || 'other'] || defaultColor
    }));
  }
  
  /**
   * Get hourly revenue for a date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Array of hourly revenue data
   */
  async getHourlyRevenue(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<HourlyRevenue[]> {
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    // Query the database for hourly revenue
    // This complex query extracts the hour from the timestamp in Eastern time
    // and aggregates the revenue by hour
    // Using a raw SQL query with proper type handling
    const result = await db.execute<{ hour: number, amount: number }>(sql`
      SELECT 
        EXTRACT(HOUR FROM COALESCE(${orders.closedAt}, ${orders.createdAt}) AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') AS hour,
        COALESCE(SUM(${orders.totalMoney}), 0) AS amount
      FROM ${orders}
      WHERE COALESCE(${orders.closedAt}, ${orders.createdAt}) BETWEEN ${start} AND ${end}
        AND ${orders.status} IN ('COMPLETED', 'OPEN')
      GROUP BY hour
      ORDER BY hour
    `);
    
    // Format hours as strings like "12 AM", "1 PM", etc.
    const hourlyRevenue: HourlyRevenue[] = [];
    
    // Check if result has rows property (standard PG result format)
    if (result && Array.isArray(result.rows)) {
      for (const row of result.rows) {
        hourlyRevenue.push({
          hour: formatHour(row.hour),
          amount: row.amount
        });
      }
    }
    return hourlyRevenue;
  }
  
  /**
   * Get total orders count for a date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Total number of orders
   */
  async getTotalOrders(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<number> {
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    const effectiveDate = sql`COALESCE(${orders.closedAt}, ${orders.createdAt})`;
    const result = await db.select({
      totalOrders: count(orders.id),
    }).from(orders)
      .where(and(
        sql`${effectiveDate} BETWEEN ${start} AND ${end}`,
        inArray(orders.status, ['COMPLETED', 'OPEN'])
      ));
    
    return result[0]?.totalOrders || 0;
  }
}

// Helper function to format hour number to AM/PM string
function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

// Create and export a singleton instance
export const orderService = new OrderService();