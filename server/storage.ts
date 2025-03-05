import { 
  Transaction, InsertTransaction, 
  GiftCard, InsertGiftCard, 
  GiftCardRedemption, InsertGiftCardRedemption,
  User, InsertUser,
  SyncState, InsertSyncState,
  DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary,
  DateRange, TransactionStatus,
  Order, InsertOrder,
  OrderLineItem, InsertOrderLineItem,
  OrderModifier, InsertOrderModifier,
  OrderDiscount, InsertOrderDiscount,
  OrderSummary
} from "@shared/schema";
import { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth } from "date-fns";

export interface IStorage {
  // User methods (keeping from original)
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Transaction methods
  getTransactions(dateRange: DateRange, startDate?: Date, endDate?: Date, status?: TransactionStatus): Promise<Transaction[]>;
  getTransactionById(id: number): Promise<Transaction | undefined>;
  getTransactionBySquareId(squareId: string): Promise<Transaction | undefined>;
  createTransaction(transaction: InsertTransaction): Promise<Transaction>;

  // Gift card methods
  getGiftCards(): Promise<GiftCard[]>;
  getGiftCardById(id: number): Promise<GiftCard | undefined>;
  getGiftCardBySquareId(squareId: string): Promise<GiftCard | undefined>;
  createGiftCard(giftCard: InsertGiftCard): Promise<GiftCard>;
  updateGiftCardRedemption(id: number, amount: number): Promise<GiftCard>;

  // Gift card redemption methods
  createGiftCardRedemption(redemption: InsertGiftCardRedemption): Promise<GiftCardRedemption>;
  getGiftCardRedemptions(giftCardId: number): Promise<GiftCardRedemption[]>;

  // Dashboard summary methods
  getDailySummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<DailySummary>;
  getCategoryRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<CategoryRevenue[]>;
  getHourlyRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<HourlyRevenue[]>;
  getGiftCardSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<GiftCardSummary>;

  // Sync state management methods
  getSyncState(syncType: string): Promise<SyncState | undefined>;
  createSyncState(syncState: InsertSyncState): Promise<SyncState>;
  updateSyncState(id: number, updates: Partial<InsertSyncState>): Promise<SyncState>;
  getSyncProgress(): Promise<{ payments: number; giftCards: number; }>;

  // Order methods
  getOrder(id: number): Promise<Order | undefined>;
  getOrderBySquareId(squareId: string): Promise<Order | undefined>;
  createOrder(order: InsertOrder): Promise<Order>;
  getOrderItems(orderId: number): Promise<OrderLineItem[]>;
  createOrderItem(item: InsertOrderLineItem): Promise<OrderLineItem>;
  getOrderModifiers(lineItemId: number): Promise<OrderModifier[]>;
  createOrderModifier(modifier: InsertOrderModifier): Promise<OrderModifier>;
  getOrderDiscounts(orderId: number): Promise<OrderDiscount[]>;
  createOrderDiscount(discount: InsertOrderDiscount): Promise<OrderDiscount>;
  getOrderSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<OrderSummary>;

  // Add new method for gift card sales
  getGiftCardSales(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<number>;
}

// No MemStorage implementation - we now exclusively use PgStorage for all data storage
// This file only contains the IStorage interface definition