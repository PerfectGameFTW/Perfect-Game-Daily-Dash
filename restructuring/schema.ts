/**
 * Database Schema Definition
 * 
 * This defines the database schema for the entire application
 * using Drizzle ORM with PostgreSQL and Zod for validation
 */
import { pgTable, text, integer, boolean, timestamp, json, real, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod';
import { type Json } from 'drizzle-orm/pg-core';

// Enum Definitions
export const dateRangeSchema = z.enum([
  'today',
  'yesterday',
  'last7days',
  'last30days',
  'thisMonth',
  'lastMonth',
  'custom'
]);
export type DateRange = z.infer<typeof dateRangeSchema>;

export const transactionStatusSchema = z.enum([
  'pending',
  'completed',
  'failed',
  'refunded',
  'canceled'
]);
export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

export const categorySchema = z.enum([
  'food',
  'drinks',
  'retail',
  'services',
  'giftCard'
]);
export type Category = z.infer<typeof categorySchema>;

export const orderStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELED',
  'REFUNDED'
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

// Payment Source Table
export const paymentSources = pgTable('payment_sources', {
  id: integer('id').primaryKey().notNull(),
  squareId: text('square_id').unique().notNull(),
  type: text('type').notNull(), // credit, debit, gift_card, cash, etc.
  brand: text('brand'), // visa, mastercard, amex, etc.
  last4: text('last4'), // last 4 digits of card
  giftCardId: integer('gift_card_id'), // reference to gift card if type is gift_card
  metadata: json('metadata').default({})
});

export const insertPaymentSourceSchema = createInsertSchema(paymentSources).omit({
  id: true
});
export type InsertPaymentSource = z.infer<typeof insertPaymentSourceSchema>;
export type PaymentSource = typeof paymentSources.$inferSelect;

// Orders Table
export const orders = pgTable('orders', {
  id: integer('id').primaryKey().notNull(),
  squareId: text('square_id').unique().notNull(),
  status: text('status').notNull().default('PENDING'),
  totalMoney: real('total_money').notNull().default(0),
  totalTax: real('total_tax').notNull().default(0),
  totalDiscount: real('total_discount').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  closedAt: timestamp('closed_at'),
  source: text('source').notNull().default('square'),
  isDeleted: boolean('is_deleted').default(false),
  squareData: json('square_data')
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
  createdAt: true
});
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

// Order Line Items Table
export const orderLineItems = pgTable('order_line_items', {
  id: integer('id').primaryKey().notNull(),
  orderId: integer('order_id').notNull().references(() => orders.id),
  name: text('name').notNull(),
  quantity: integer('quantity').notNull().default(1),
  totalMoney: real('total_money').notNull().default(0),
  basePriceMoney: real('base_price_money').notNull().default(0),
  productId: text('product_id'),
  isGiftCard: boolean('is_gift_card').default(false),
  category: text('category'),
  squareData: json('square_data')
});

export const insertOrderLineItemSchema = createInsertSchema(orderLineItems).omit({
  id: true
});
export type InsertOrderLineItem = z.infer<typeof insertOrderLineItemSchema>;
export type OrderLineItem = typeof orderLineItems.$inferSelect;

// Order Modifiers Table
export const orderModifiers = pgTable('order_modifiers', {
  id: integer('id').primaryKey().notNull(),
  lineItemId: integer('line_item_id').notNull().references(() => orderLineItems.id),
  name: text('name').notNull(),
  priceMoney: real('price_money').notNull().default(0),
  squareData: json('square_data')
});

export const insertOrderModifierSchema = createInsertSchema(orderModifiers).omit({
  id: true
});
export type InsertOrderModifier = z.infer<typeof insertOrderModifierSchema>;
export type OrderModifier = typeof orderModifiers.$inferSelect;

// Order Discounts Table
export const orderDiscounts = pgTable('order_discounts', {
  id: integer('id').primaryKey().notNull(),
  orderId: integer('order_id').notNull().references(() => orders.id),
  name: text('name').notNull(),
  amount: real('amount').notNull().default(0),
  percentage: real('percentage'),
  scope: text('scope').default('ORDER'), // ORDER or LINE_ITEM
  targetId: text('target_id'), // If scope is LINE_ITEM, this is the line item ID
  squareData: json('square_data')
});

export const insertOrderDiscountSchema = createInsertSchema(orderDiscounts).omit({
  id: true
});
export type InsertOrderDiscount = z.infer<typeof insertOrderDiscountSchema>;
export type OrderDiscount = typeof orderDiscounts.$inferSelect;

// Payments Table (previously transactions)
export const payments = pgTable('payments', {
  id: integer('id').primaryKey().notNull(),
  squareId: text('square_id').unique().notNull(),
  status: text('status').notNull().default('pending'),
  amount: real('amount').notNull().default(0),
  tipAmount: real('tip_amount').notNull().default(0),
  taxAmount: real('tax_amount').notNull().default(0),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  currency: text('currency').notNull().default('USD'),
  orderId: integer('order_id').references(() => orders.id),
  sourceId: integer('source_id').references(() => paymentSources.id),
  squareOrderId: text('square_order_id'),
  receiptUrl: text('receipt_url'),
  isGiftCardActivation: boolean('is_gift_card_activation').default(false),
  giftCardId: integer('gift_card_id').references(() => giftCards.id),
  metadata: json('metadata').default({})
});

export const insertPaymentSchema = createInsertSchema(payments).omit({
  id: true,
  timestamp: true
});
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof payments.$inferSelect;

// Gift Cards Table
export const giftCards = pgTable('gift_cards', {
  id: integer('id').primaryKey().notNull(),
  squareId: text('square_id').unique().notNull(),
  gan: text('gan').unique().notNull(), // Gift card number
  currentBalance: real('current_balance').notNull().default(0),
  activationAmount: real('activation_amount').notNull().default(0),
  redeemedAmount: real('redeemed_amount').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  state: text('state').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  activatedAt: timestamp('activated_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at'),
  customerId: text('customer_id'),
  activationPaymentId: integer('activation_payment_id').references(() => payments.id),
  squareData: json('square_data').default({})
});

export const insertGiftCardSchema = createInsertSchema(giftCards).omit({
  id: true,
  createdAt: true
});
export type InsertGiftCard = z.infer<typeof insertGiftCardSchema>;
export type GiftCard = typeof giftCards.$inferSelect;

// Gift Card Redemptions Table
export const giftCardRedemptions = pgTable('gift_card_redemptions', {
  id: integer('id').primaryKey().notNull(),
  giftCardId: integer('gift_card_id').notNull().references(() => giftCards.id),
  paymentId: integer('payment_id').references(() => payments.id),
  orderId: integer('order_id').references(() => orders.id),
  amount: real('amount').notNull().default(0),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  squareData: json('square_data')
});

export const insertGiftCardRedemptionSchema = createInsertSchema(
  giftCardRedemptions
).omit({
  id: true
});
export type InsertGiftCardRedemption = z.infer<typeof insertGiftCardRedemptionSchema>;
export type GiftCardRedemption = typeof giftCardRedemptions.$inferSelect;

// Sync State Table
export const syncState = pgTable('sync_state', {
  id: integer('id').primaryKey().notNull(),
  syncType: text('sync_type').notNull().unique(), // orders, payments, gift_cards, etc.
  lastSyncedAt: timestamp('last_synced_at').notNull().defaultNow(),
  status: text('status').default('pending'),
  cursor: text('cursor'),
  processedCount: integer('processed_count').default(0),
  totalCount: integer('total_count').default(0),
  isComplete: boolean('is_complete').default(false),
  errorMessage: text('error_message'),
  lastCheckpoint: json('last_checkpoint')
});

export const insertSyncStateSchema = createInsertSchema(syncState).omit({
  id: true
});
export type InsertSyncState = z.infer<typeof insertSyncStateSchema>;
export type SyncState = typeof syncState.$inferSelect;

// Users Table
export const users = pgTable('users', {
  id: integer('id').primaryKey().notNull(),
  username: text('username').notNull().unique(),
  password: text('password').notNull(),
  email: text('email'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  role: text('role').notNull().default('user'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at')
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Data Model Interfaces for Analytics and Reporting

// Summary of orders for a period
export interface OrderSummary {
  totalOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
  itemsSold: number;
  topSellingItems: Array<{
    name: string;
    quantity: number;
    revenue: number;
  }>;
  discountTotal: number;
  taxTotal: number;
}

// Summary of daily metrics with change percentage
export interface DailySummary {
  totalRevenue: number;
  revenueChange: number;
  totalOrders: number;
  ordersChange: number;
  averageOrder: number;
  averageOrderChange: number;
  giftCardSales: number;
  giftCardSalesChange: number;
  date: string;
}

// Revenue by category for charts
export interface CategoryRevenue {
  category: string;
  amount: number;
  color: string;
}

// Hourly revenue breakdown for charts
export interface HourlyRevenue {
  hour: string;
  amount: number;
}

// Gift card activity summary
export interface GiftCardSummary {
  soldCount: number;
  soldAmount: number;
  redeemedCount: number;
  redeemedAmount: number;
  averageValue: number;
}