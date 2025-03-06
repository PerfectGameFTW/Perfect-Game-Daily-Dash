/**
 * PostgreSQL Storage Implementation
 * 
 * Implements the IStorage interface using Drizzle ORM
 * with consistent error handling and transaction management
 */
import { 
  IStorage 
} from './storage';
import {
  Order, InsertOrder, orders,
  OrderLineItem, InsertOrderLineItem, orderLineItems,
  OrderModifier, InsertOrderModifier, orderModifiers,
  OrderDiscount, InsertOrderDiscount, orderDiscounts,
  Payment, InsertPayment, payments,
  PaymentSource, InsertPaymentSource, paymentSources,
  GiftCard, InsertGiftCard, giftCards,
  GiftCardRedemption, InsertGiftCardRedemption, giftCardRedemptions,
  User, InsertUser, users,
  SyncState, InsertSyncState, syncState,
  OrderSummary, DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary,
  DateRange, TransactionStatus, Category
} from './schema';
import { eq, and, gte, lte, desc, sql, asc, count, sum, avg, isNull, inArray } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';

/**
 * Common error types for storage operations
 */
export class StorageError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'StorageError';
  }
}

export class NotFoundError extends StorageError {
  constructor(entity: string, id: string | number) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND');
  }
}

export class DuplicateEntityError extends StorageError {
  constructor(entity: string, identifier: string) {
    super(`${entity} with this ${identifier} already exists`, 'DUPLICATE_ENTITY');
  }
}

/**
 * Type for database connection including transaction support
 */
export interface DatabaseClient {
  execute: (query: any) => Promise<any>;
  select: (...args: any[]) => Promise<any>;
  insert: (...args: any[]) => Promise<any>;
  update: (...args: any[]) => Promise<any>;
  delete: (...args: any[]) => Promise<any>;
  transaction: <T>(callback: (tx: PgTransaction) => Promise<T>) => Promise<T>;
}

/**
 * PostgreSQL storage implementation
 */
export class PgStorage implements IStorage {
  constructor(private db: DatabaseClient) {}

  // Helper method to handle database errors consistently
  private handleDbError(error: any, entity: string, operation: string): never {
    console.error(`Database error during ${operation} on ${entity}:`, error);
    
    // Check common error types
    if (error.code === '23505') { // Unique violation
      throw new DuplicateEntityError(entity, error.detail || 'unknown field');
    }
    
    if (error.code === '23503') { // Foreign key violation
      throw new StorageError(
        `Foreign key constraint violation: ${error.detail || 'unknown constraint'}`,
        'FOREIGN_KEY_VIOLATION'
      );
    }
    
    if (error instanceof StorageError) {
      throw error;
    }
    
    throw new StorageError(
      `Database error during ${operation} on ${entity}`,
      'DATABASE_ERROR',
      error.message || String(error)
    );
  }

  /* User Management */
  
  async getUser(id: number): Promise<User | undefined> {
    try {
      const result = await this.db.select().from(users).where(eq(users.id, id));
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'User', 'getUser');
    }
  }
  
  async getUserByUsername(username: string): Promise<User | undefined> {
    try {
      const result = await this.db.select().from(users).where(eq(users.username, username));
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'User', 'getUserByUsername');
    }
  }
  
  async createUser(user: InsertUser): Promise<User> {
    try {
      const result = await this.db.insert(users).values(user).returning();
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'User', 'createUser');
    }
  }
  
  async updateUser(id: number, updates: Partial<InsertUser>): Promise<User> {
    try {
      const result = await this.db.update(users)
        .set(updates)
        .where(eq(users.id, id))
        .returning();
      
      if (result.length === 0) {
        throw new NotFoundError('User', id);
      }
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'User', 'updateUser');
    }
  }

  /* Order Management */
  
  async getOrder(id: number): Promise<Order | undefined> {
    try {
      const result = await this.db.select().from(orders).where(eq(orders.id, id));
      
      if (result.length === 0) {
        return undefined;
      }
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'Order', 'getOrder');
    }
  }
  
  async getOrderBySquareId(squareId: string): Promise<Order | undefined> {
    try {
      const result = await this.db.select()
        .from(orders)
        .where(eq(orders.squareId, squareId));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'Order', 'getOrderBySquareId');
    }
  }
  
  async listOrdersByDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<Order[]> {
    try {
      // Use the date parameters directly as UTC timestamps
      const query = this.db.select()
        .from(orders)
        .where(and(
          gte(orders.createdAt, startDate || new Date(0)),
          lte(orders.createdAt, endDate || new Date()),
          eq(orders.isDeleted, false)
        ))
        .orderBy(desc(orders.createdAt));
      
      return await query;
    } catch (error) {
      this.handleDbError(error, 'Order', 'listOrdersByDateRange');
    }
  }
  
  async createOrder(order: InsertOrder): Promise<Order> {
    try {
      const result = await this.db.insert(orders)
        .values(order)
        .returning();
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'Order', 'createOrder');
    }
  }
  
  async updateOrder(id: number, updates: Partial<InsertOrder>): Promise<Order> {
    try {
      const result = await this.db.update(orders)
        .set(updates)
        .where(eq(orders.id, id))
        .returning();
      
      if (result.length === 0) {
        throw new NotFoundError('Order', id);
      }
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'Order', 'updateOrder');
    }
  }
  
  async deleteOrder(id: number): Promise<boolean> {
    try {
      // Soft delete (update isDeleted flag)
      const result = await this.db.update(orders)
        .set({ isDeleted: true })
        .where(eq(orders.id, id))
        .returning({ id: orders.id });
      
      return result.length > 0;
    } catch (error) {
      this.handleDbError(error, 'Order', 'deleteOrder');
    }
  }
  
  /* Order Line Items */
  
  async getOrderItems(orderId: number): Promise<OrderLineItem[]> {
    try {
      return await this.db.select()
        .from(orderLineItems)
        .where(eq(orderLineItems.orderId, orderId))
        .orderBy(asc(orderLineItems.id));
    } catch (error) {
      this.handleDbError(error, 'OrderLineItem', 'getOrderItems');
    }
  }
  
  async getLineItem(id: number): Promise<OrderLineItem | undefined> {
    try {
      const result = await this.db.select()
        .from(orderLineItems)
        .where(eq(orderLineItems.id, id));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'OrderLineItem', 'getLineItem');
    }
  }
  
  async createOrderItem(item: InsertOrderLineItem): Promise<OrderLineItem> {
    try {
      const result = await this.db.insert(orderLineItems)
        .values(item)
        .returning();
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'OrderLineItem', 'createOrderItem');
    }
  }
  
  async updateOrderItem(id: number, updates: Partial<InsertOrderLineItem>): Promise<OrderLineItem> {
    try {
      const result = await this.db.update(orderLineItems)
        .set(updates)
        .where(eq(orderLineItems.id, id))
        .returning();
      
      if (result.length === 0) {
        throw new NotFoundError('OrderLineItem', id);
      }
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'OrderLineItem', 'updateOrderItem');
    }
  }
  
  async deleteOrderItem(id: number): Promise<boolean> {
    try {
      const result = await this.db.delete(orderLineItems)
        .where(eq(orderLineItems.id, id))
        .returning({ id: orderLineItems.id });
      
      return result.length > 0;
    } catch (error) {
      this.handleDbError(error, 'OrderLineItem', 'deleteOrderItem');
    }
  }
  
  /* Order Modifiers */
  
  async getOrderModifiers(lineItemId: number): Promise<OrderModifier[]> {
    try {
      return await this.db.select()
        .from(orderModifiers)
        .where(eq(orderModifiers.lineItemId, lineItemId))
        .orderBy(asc(orderModifiers.id));
    } catch (error) {
      this.handleDbError(error, 'OrderModifier', 'getOrderModifiers');
    }
  }
  
  async createOrderModifier(modifier: InsertOrderModifier): Promise<OrderModifier> {
    try {
      const result = await this.db.insert(orderModifiers)
        .values(modifier)
        .returning();
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'OrderModifier', 'createOrderModifier');
    }
  }
  
  /* Order Discounts */
  
  async getOrderDiscounts(orderId: number): Promise<OrderDiscount[]> {
    try {
      return await this.db.select()
        .from(orderDiscounts)
        .where(eq(orderDiscounts.orderId, orderId))
        .orderBy(asc(orderDiscounts.id));
    } catch (error) {
      this.handleDbError(error, 'OrderDiscount', 'getOrderDiscounts');
    }
  }
  
  async createOrderDiscount(discount: InsertOrderDiscount): Promise<OrderDiscount> {
    try {
      const result = await this.db.insert(orderDiscounts)
        .values(discount)
        .returning();
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'OrderDiscount', 'createOrderDiscount');
    }
  }
  
  /* Payment Management */
  
  async getPayment(id: number): Promise<Payment | undefined> {
    try {
      const result = await this.db.select()
        .from(payments)
        .where(eq(payments.id, id));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'Payment', 'getPayment');
    }
  }
  
  async getPaymentBySquareId(squareId: string): Promise<Payment | undefined> {
    try {
      const result = await this.db.select()
        .from(payments)
        .where(eq(payments.squareId, squareId));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'Payment', 'getPaymentBySquareId');
    }
  }
  
  async listPaymentsByDateRange(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date,
    status?: TransactionStatus
  ): Promise<Payment[]> {
    try {
      // Build query with date range
      let query = this.db.select()
        .from(payments)
        .where(and(
          gte(payments.timestamp, startDate || new Date(0)),
          lte(payments.timestamp, endDate || new Date())
        ));
      
      // Add status filter if provided
      if (status) {
        query = query.where(eq(payments.status, status));
      }
      
      // Order by most recent first
      query = query.orderBy(desc(payments.timestamp));
      
      return await query;
    } catch (error) {
      this.handleDbError(error, 'Payment', 'listPaymentsByDateRange');
    }
  }
  
  async createPayment(payment: InsertPayment): Promise<Payment> {
    try {
      const result = await this.db.insert(payments)
        .values(payment)
        .returning();
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'Payment', 'createPayment');
    }
  }
  
  async updatePayment(id: number, updates: Partial<InsertPayment>): Promise<Payment> {
    try {
      const result = await this.db.update(payments)
        .set(updates)
        .where(eq(payments.id, id))
        .returning();
      
      if (result.length === 0) {
        throw new NotFoundError('Payment', id);
      }
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'Payment', 'updatePayment');
    }
  }
  
  /* Payment Sources */
  
  async getPaymentSource(id: number): Promise<PaymentSource | undefined> {
    try {
      const result = await this.db.select()
        .from(paymentSources)
        .where(eq(paymentSources.id, id));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'PaymentSource', 'getPaymentSource');
    }
  }
  
  async getPaymentSourceBySquareId(squareId: string): Promise<PaymentSource | undefined> {
    try {
      const result = await this.db.select()
        .from(paymentSources)
        .where(eq(paymentSources.squareId, squareId));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'PaymentSource', 'getPaymentSourceBySquareId');
    }
  }
  
  async createPaymentSource(source: InsertPaymentSource): Promise<PaymentSource> {
    try {
      const result = await this.db.insert(paymentSources)
        .values(source)
        .returning();
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'PaymentSource', 'createPaymentSource');
    }
  }
  
  async updatePaymentSource(id: number, updates: Partial<InsertPaymentSource>): Promise<PaymentSource> {
    try {
      const result = await this.db.update(paymentSources)
        .set(updates)
        .where(eq(paymentSources.id, id))
        .returning();
      
      if (result.length === 0) {
        throw new NotFoundError('PaymentSource', id);
      }
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'PaymentSource', 'updatePaymentSource');
    }
  }
  
  /* Gift Card Management */
  
  async getGiftCard(id: number): Promise<GiftCard | undefined> {
    try {
      const result = await this.db.select()
        .from(giftCards)
        .where(eq(giftCards.id, id));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'GiftCard', 'getGiftCard');
    }
  }
  
  async getGiftCardBySquareId(squareId: string): Promise<GiftCard | undefined> {
    try {
      const result = await this.db.select()
        .from(giftCards)
        .where(eq(giftCards.squareId, squareId));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'GiftCard', 'getGiftCardBySquareId');
    }
  }
  
  async getGiftCardByGAN(gan: string): Promise<GiftCard | undefined> {
    try {
      const result = await this.db.select()
        .from(giftCards)
        .where(eq(giftCards.gan, gan));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'GiftCard', 'getGiftCardByGAN');
    }
  }
  
  async listGiftCards(activeOnly: boolean = false): Promise<GiftCard[]> {
    try {
      let query = this.db.select().from(giftCards);
      
      if (activeOnly) {
        query = query.where(eq(giftCards.isActive, true));
      }
      
      query = query.orderBy(desc(giftCards.createdAt));
      
      return await query;
    } catch (error) {
      this.handleDbError(error, 'GiftCard', 'listGiftCards');
    }
  }
  
  async createGiftCard(giftCard: InsertGiftCard): Promise<GiftCard> {
    try {
      const result = await this.db.insert(giftCards)
        .values(giftCard)
        .returning();
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'GiftCard', 'createGiftCard');
    }
  }
  
  async updateGiftCard(id: number, updates: Partial<InsertGiftCard>): Promise<GiftCard> {
    try {
      const result = await this.db.update(giftCards)
        .set(updates)
        .where(eq(giftCards.id, id))
        .returning();
      
      if (result.length === 0) {
        throw new NotFoundError('GiftCard', id);
      }
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'GiftCard', 'updateGiftCard');
    }
  }
  
  /* Gift Card Redemptions */
  
  async getGiftCardRedemptions(giftCardId: number): Promise<GiftCardRedemption[]> {
    try {
      return await this.db.select()
        .from(giftCardRedemptions)
        .where(eq(giftCardRedemptions.giftCardId, giftCardId))
        .orderBy(desc(giftCardRedemptions.timestamp));
    } catch (error) {
      this.handleDbError(error, 'GiftCardRedemption', 'getGiftCardRedemptions');
    }
  }
  
  async createGiftCardRedemption(redemption: InsertGiftCardRedemption): Promise<GiftCardRedemption> {
    try {
      const result = await this.db.insert(giftCardRedemptions)
        .values(redemption)
        .returning();
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'GiftCardRedemption', 'createGiftCardRedemption');
    }
  }
  
  /* Sync State Management */
  
  async getSyncState(syncType: string): Promise<SyncState | undefined> {
    try {
      const result = await this.db.select()
        .from(syncState)
        .where(eq(syncState.syncType, syncType));
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'SyncState', 'getSyncState');
    }
  }
  
  async createSyncState(state: InsertSyncState): Promise<SyncState> {
    try {
      const result = await this.db.insert(syncState)
        .values(state)
        .returning();
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'SyncState', 'createSyncState');
    }
  }
  
  async updateSyncState(id: number, updates: Partial<InsertSyncState>): Promise<SyncState> {
    try {
      const result = await this.db.update(syncState)
        .set(updates)
        .where(eq(syncState.id, id))
        .returning();
      
      if (result.length === 0) {
        throw new NotFoundError('SyncState', id);
      }
      
      return result[0];
    } catch (error) {
      this.handleDbError(error, 'SyncState', 'updateSyncState');
    }
  }
  
  async getSyncProgress(): Promise<{ [key: string]: number }> {
    try {
      const states = await this.db.select().from(syncState);
      
      // Calculate progress for each sync type
      const progress: { [key: string]: number } = {};
      
      for (const state of states) {
        if (state.totalCount > 0) {
          progress[state.syncType] = Math.min(100, Math.round((state.processedCount / state.totalCount) * 100));
        } else {
          progress[state.syncType] = state.isComplete ? 100 : 0;
        }
      }
      
      return progress;
    } catch (error) {
      this.handleDbError(error, 'SyncState', 'getSyncProgress');
    }
  }
  
  /* Reporting & Analytics */
  
  async getOrderSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<OrderSummary> {
    try {
      // Get total orders and revenue in the date range
      const orderResults = await this.db.select({
        totalOrders: count(),
        totalRevenue: sum(orders.totalMoney),
        taxTotal: sum(orders.totalTax),
        discountTotal: sum(orders.totalDiscount)
      })
      .from(orders)
      .where(and(
        gte(orders.createdAt, startDate || new Date(0)),
        lte(orders.createdAt, endDate || new Date()),
        eq(orders.isDeleted, false),
        inArray(orders.status, ['COMPLETED', 'COMPLETED']),
      ));
      
      const summaryBase = {
        totalOrders: Number(orderResults[0]?.totalOrders || 0),
        totalRevenue: Number(orderResults[0]?.totalRevenue || 0),
        averageOrderValue: 0,
        itemsSold: 0,
        topSellingItems: [],
        discountTotal: Number(orderResults[0]?.discountTotal || 0),
        taxTotal: Number(orderResults[0]?.taxTotal || 0)
      };
      
      // Calculate average order value
      if (summaryBase.totalOrders > 0) {
        summaryBase.averageOrderValue = summaryBase.totalRevenue / summaryBase.totalOrders;
      }
      
      // Get total items sold
      const itemResults = await this.db.select({
        totalItems: sum(orderLineItems.quantity)
      })
      .from(orderLineItems)
      .innerJoin(
        orders,
        eq(orderLineItems.orderId, orders.id)
      )
      .where(and(
        gte(orders.createdAt, startDate || new Date(0)),
        lte(orders.createdAt, endDate || new Date()),
        eq(orders.isDeleted, false),
        inArray(orders.status, ['COMPLETED', 'COMPLETED']),
      ));
      
      summaryBase.itemsSold = Number(itemResults[0]?.totalItems || 0);
      
      // Get top selling items
      const topItems = await this.db.select({
        name: orderLineItems.name,
        quantity: sum(orderLineItems.quantity),
        revenue: sum(orderLineItems.totalMoney)
      })
      .from(orderLineItems)
      .innerJoin(
        orders,
        eq(orderLineItems.orderId, orders.id)
      )
      .where(and(
        gte(orders.createdAt, startDate || new Date(0)),
        lte(orders.createdAt, endDate || new Date()),
        eq(orders.isDeleted, false),
        inArray(orders.status, ['COMPLETED', 'COMPLETED']),
        eq(orderLineItems.isGiftCard, false) // Exclude gift cards from top selling items
      ))
      .groupBy(orderLineItems.name)
      .orderBy(desc(sum(orderLineItems.quantity)))
      .limit(5);
      
      summaryBase.topSellingItems = topItems.map(item => ({
        name: item.name,
        quantity: Number(item.quantity) || 0,
        revenue: Number(item.revenue) || 0
      }));
      
      return summaryBase;
    } catch (error) {
      this.handleDbError(error, 'OrderSummary', 'getOrderSummary');
    }
  }
  
  async getDailySummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<DailySummary> {
    try {
      // Use SQL to get total revenue and orders in date range
      const currentQuery = await this.db.execute(sql`
        SELECT 
          COALESCE(SUM(total_money), 0) as total_revenue,
          COUNT(*) as total_orders
        FROM orders
        WHERE 
          created_at >= ${startDate || new Date(0)} AND
          created_at <= ${endDate || new Date()} AND
          is_deleted = false AND
          status IN ('COMPLETED', 'COMPLETED')
      `);
      
      // Get gift card sales in date range
      const giftCardQuery = await this.db.execute(sql`
        SELECT COALESCE(SUM(p.amount), 0) as gift_card_sales
        FROM payments p
        WHERE 
          p.timestamp >= ${startDate || new Date(0)} AND
          p.timestamp <= ${endDate || new Date()} AND
          p.is_gift_card_activation = true AND
          p.status = 'completed'
      `);
      
      // Get previous period data for comparison
      // Calculate previous period dates based on current range
      const currentPeriodDays = endDate && startDate 
        ? Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000))
        : 1;
      
      const previousStartDate = startDate 
        ? new Date(startDate.getTime() - (currentPeriodDays * 24 * 60 * 60 * 1000))
        : new Date(0);
      
      const previousEndDate = startDate
        ? new Date(startDate.getTime() - 1)
        : new Date(0);
      
      // Get previous period revenue and orders
      const previousQuery = await this.db.execute(sql`
        SELECT 
          COALESCE(SUM(total_money), 0) as total_revenue,
          COUNT(*) as total_orders
        FROM orders
        WHERE 
          created_at >= ${previousStartDate} AND
          created_at <= ${previousEndDate} AND
          is_deleted = false AND
          status IN ('COMPLETED', 'COMPLETED')
      `);
      
      // Get previous period gift card sales
      const previousGiftCardQuery = await this.db.execute(sql`
        SELECT COALESCE(SUM(p.amount), 0) as gift_card_sales
        FROM payments p
        WHERE 
          p.timestamp >= ${previousStartDate} AND
          p.timestamp <= ${previousEndDate} AND
          p.is_gift_card_activation = true AND
          p.status = 'completed'
      `);
      
      // Process results
      const totalRevenue = Number(currentQuery.rows[0]?.total_revenue || 0);
      const totalOrders = Number(currentQuery.rows[0]?.total_orders || 0);
      const giftCardSales = Number(giftCardQuery.rows[0]?.gift_card_sales || 0);
      
      const previousRevenue = Number(previousQuery.rows[0]?.total_revenue || 0);
      const previousOrders = Number(previousQuery.rows[0]?.total_orders || 0);
      const previousGiftCardSales = Number(previousGiftCardQuery.rows[0]?.gift_card_sales || 0);
      
      // Calculate change percentages
      const revenueChange = previousRevenue === 0 
        ? 1 // 100% increase if previous was 0
        : (totalRevenue - previousRevenue) / previousRevenue;
      
      const ordersChange = previousOrders === 0
        ? 1 
        : (totalOrders - previousOrders) / previousOrders;
      
      const averageOrder = totalOrders === 0 ? 0 : totalRevenue / totalOrders;
      const previousAverageOrder = previousOrders === 0 ? 0 : previousRevenue / previousOrders;
      
      const averageOrderChange = previousAverageOrder === 0
        ? 1
        : (averageOrder - previousAverageOrder) / previousAverageOrder;
      
      const giftCardSalesChange = previousGiftCardSales === 0
        ? 1
        : (giftCardSales - previousGiftCardSales) / previousGiftCardSales;
      
      // Format date for display
      const date = endDate?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0];
      
      return {
        totalRevenue,
        revenueChange,
        totalOrders,
        ordersChange,
        averageOrder,
        averageOrderChange,
        giftCardSales,
        giftCardSalesChange,
        date
      };
    } catch (error) {
      this.handleDbError(error, 'DailySummary', 'getDailySummary');
    }
  }
  
  async getCategoryRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<CategoryRevenue[]> {
    try {
      // Query sales by category
      const results = await this.db.execute(sql`
        SELECT 
          oli.category,
          SUM(oli.total_money) as total
        FROM order_line_items oli
        JOIN orders o ON oli.order_id = o.id
        WHERE 
          o.created_at >= ${startDate || new Date(0)} AND
          o.created_at <= ${endDate || new Date()} AND
          o.is_deleted = false AND
          o.status IN ('COMPLETED', 'COMPLETED')
        GROUP BY oli.category
        ORDER BY total DESC
      `);
      
      // Map category names to colors
      const categoryColors: { [key: string]: string } = {
        food: '#4CAF50',     // Green
        drinks: '#2196F3',   // Blue
        retail: '#FF9800',   // Orange
        services: '#9C27B0', // Purple
        giftCard: '#F44336'  // Red
      };
      
      // Map results to expected format
      return results.rows.map(row => ({
        category: row.category,
        amount: Number(row.total) || 0,
        color: categoryColors[row.category] || '#CCCCCC'
      }));
    } catch (error) {
      this.handleDbError(error, 'CategoryRevenue', 'getCategoryRevenue');
    }
  }
  
  async getHourlyRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<HourlyRevenue[]> {
    try {
      // Query hourly revenue distribution
      const results = await this.db.execute(sql`
        SELECT 
          EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC') as hour,
          SUM(total_money) as amount
        FROM orders
        WHERE 
          created_at >= ${startDate || new Date(0)} AND
          created_at <= ${endDate || new Date()} AND
          is_deleted = false AND
          status IN ('COMPLETED', 'COMPLETED')
        GROUP BY hour
        ORDER BY hour
      `);
      
      // Create array with all 24 hours, zero-filled
      const hourlyData: HourlyRevenue[] = Array.from({ length: 24 }, (_, i) => ({
        hour: i.toString(),
        amount: 0
      }));
      
      // Fill in actual values
      results.rows.forEach(row => {
        const hour = Number(row.hour);
        hourlyData[hour].amount = Number(row.amount) || 0;
      });
      
      return hourlyData;
    } catch (error) {
      this.handleDbError(error, 'HourlyRevenue', 'getHourlyRevenue');
    }
  }
  
  async getGiftCardSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<GiftCardSummary> {
    try {
      // Get gift card sales
      const salesQuery = await this.db.execute(sql`
        SELECT 
          COUNT(*) as sold_count,
          COALESCE(SUM(amount), 0) as sold_amount
        FROM payments
        WHERE 
          timestamp >= ${startDate || new Date(0)} AND
          timestamp <= ${endDate || new Date()} AND
          is_gift_card_activation = true AND
          status = 'completed'
      `);
      
      // Get gift card redemptions
      const redemptionsQuery = await this.db.execute(sql`
        SELECT 
          COUNT(*) as redeemed_count,
          COALESCE(SUM(amount), 0) as redeemed_amount
        FROM gift_card_redemptions
        WHERE 
          timestamp >= ${startDate || new Date(0)} AND
          timestamp <= ${endDate || new Date()}
      `);
      
      // Process results
      const soldCount = Number(salesQuery.rows[0]?.sold_count || 0);
      const soldAmount = Number(salesQuery.rows[0]?.sold_amount || 0);
      const redeemedCount = Number(redemptionsQuery.rows[0]?.redeemed_count || 0);
      const redeemedAmount = Number(redemptionsQuery.rows[0]?.redeemed_amount || 0);
      
      // Calculate average value
      const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;
      
      return {
        soldCount,
        soldAmount,
        redeemedCount,
        redeemedAmount,
        averageValue
      };
    } catch (error) {
      this.handleDbError(error, 'GiftCardSummary', 'getGiftCardSummary');
    }
  }
  
  async getGiftCardSales(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<number> {
    try {
      // Get total gift card sales in date range
      const result = await this.db.execute(sql`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM payments
        WHERE 
          timestamp >= ${startDate || new Date(0)} AND
          timestamp <= ${endDate || new Date()} AND
          is_gift_card_activation = true AND
          status = 'completed'
      `);
      
      return Number(result.rows[0]?.total || 0);
    } catch (error) {
      this.handleDbError(error, 'GiftCardSales', 'getGiftCardSales');
    }
  }
}