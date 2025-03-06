/**
 * Storage interface with clear separation of concerns:
 * - Each domain has its own set of methods
 * - All methods return Promises with clear return types
 * - Error handling is consistent throughout
 */
import {
  User, InsertUser,
  Order, InsertOrder,
  OrderLineItem, InsertOrderLineItem,
  OrderModifier, InsertOrderModifier,
  OrderDiscount, InsertOrderDiscount,
  Payment, InsertPayment,
  PaymentSource, InsertPaymentSource,
  GiftCard, InsertGiftCard,
  GiftCardRedemption, InsertGiftCardRedemption,
  SyncState, InsertSyncState,
  OrderSummary, DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary,
  DateRange, TransactionStatus
} from './schema';

export interface IStorage {
  /* User Management */
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, user: Partial<InsertUser>): Promise<User>;

  /* Order Management */
  getOrder(id: number): Promise<Order | undefined>;
  getOrderBySquareId(squareId: string): Promise<Order | undefined>;
  listOrdersByDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<Order[]>;
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrder(id: number, order: Partial<InsertOrder>): Promise<Order>;
  deleteOrder(id: number): Promise<boolean>;
  
  /* Order Line Items */
  getOrderItems(orderId: number): Promise<OrderLineItem[]>;
  getLineItem(id: number): Promise<OrderLineItem | undefined>;
  createOrderItem(item: InsertOrderLineItem): Promise<OrderLineItem>;
  updateOrderItem(id: number, item: Partial<InsertOrderLineItem>): Promise<OrderLineItem>;
  deleteOrderItem(id: number): Promise<boolean>;
  
  /* Order Modifiers */
  getOrderModifiers(lineItemId: number): Promise<OrderModifier[]>;
  createOrderModifier(modifier: InsertOrderModifier): Promise<OrderModifier>;
  
  /* Order Discounts */
  getOrderDiscounts(orderId: number): Promise<OrderDiscount[]>;
  createOrderDiscount(discount: InsertOrderDiscount): Promise<OrderDiscount>;
  
  /* Payment Management */
  getPayment(id: number): Promise<Payment | undefined>;
  getPaymentBySquareId(squareId: string): Promise<Payment | undefined>;
  listPaymentsByDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date, status?: TransactionStatus): Promise<Payment[]>;
  createPayment(payment: InsertPayment): Promise<Payment>;
  updatePayment(id: number, payment: Partial<InsertPayment>): Promise<Payment>;
  
  /* Payment Sources */
  getPaymentSource(id: number): Promise<PaymentSource | undefined>;
  getPaymentSourceBySquareId(squareId: string): Promise<PaymentSource | undefined>;
  createPaymentSource(source: InsertPaymentSource): Promise<PaymentSource>;
  updatePaymentSource(id: number, source: Partial<InsertPaymentSource>): Promise<PaymentSource>;
  
  /* Gift Card Management */
  getGiftCard(id: number): Promise<GiftCard | undefined>;
  getGiftCardBySquareId(squareId: string): Promise<GiftCard | undefined>;
  getGiftCardByGAN(gan: string): Promise<GiftCard | undefined>;
  listGiftCards(activeOnly?: boolean): Promise<GiftCard[]>;
  createGiftCard(giftCard: InsertGiftCard): Promise<GiftCard>;
  updateGiftCard(id: number, giftCard: Partial<InsertGiftCard>): Promise<GiftCard>;
  
  /* Gift Card Redemptions */
  getGiftCardRedemptions(giftCardId: number): Promise<GiftCardRedemption[]>;
  createGiftCardRedemption(redemption: InsertGiftCardRedemption): Promise<GiftCardRedemption>;
  
  /* Sync State Management */
  getSyncState(syncType: string): Promise<SyncState | undefined>;
  createSyncState(state: InsertSyncState): Promise<SyncState>;
  updateSyncState(id: number, updates: Partial<InsertSyncState>): Promise<SyncState>;
  getSyncProgress(): Promise<{ [key: string]: number }>;
  
  /* Reporting & Analytics */
  getOrderSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<OrderSummary>;
  getDailySummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<DailySummary>;
  getCategoryRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<CategoryRevenue[]>;
  getHourlyRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<HourlyRevenue[]>;
  getGiftCardSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<GiftCardSummary>;
  getGiftCardSales(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<number>;
}