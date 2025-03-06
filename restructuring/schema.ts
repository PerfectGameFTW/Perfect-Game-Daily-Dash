import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  real,
  jsonb,
  primaryKey,
  sql,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Common enums for the application
export const dateRangeSchema = z.enum([
  "today",
  "yesterday",
  "last7days",
  "last30days",
  "thisMonth",
  "lastMonth",
  "custom",
]);

export type DateRange = z.infer<typeof dateRangeSchema>;

export const transactionStatusSchema = z.enum([
  "completed",
  "refunded",
  "failed",
  "pending",
]);

export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

export const categorySchema = z.enum([
  "food",
  "drinks",
  "retail",
  "services",
  "giftCard",
]);

export type Category = z.infer<typeof categorySchema>;

export const orderStatusSchema = z.enum([
  "OPEN",
  "COMPLETED",
  "CANCELED",
  "DRAFT",
  "PENDING"
]);

export type OrderStatus = z.infer<typeof orderStatusSchema>;

// Payment sources table (new)
export const paymentSources = pgTable("payment_sources", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  type: text("type").notNull(), // CARD, CASH, GIFT_CARD, etc.
  last4: text("last4"), // Last 4 digits if card
  brand: text("brand"), // Card brand or GIFT_CARD
  giftCardId: integer("gift_card_id"), // Only for gift card payments
  metadata: jsonb("metadata"), // Additional payment source details
});

export const insertPaymentSourceSchema = createInsertSchema(paymentSources).omit({
  id: true,
});

export type InsertPaymentSource = z.infer<typeof insertPaymentSourceSchema>;
export type PaymentSource = typeof paymentSources.$inferSelect;

// Orders table - main source of truth for sales
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  status: text("status").notNull(),
  totalMoney: real("total_money").notNull(), // Store in dollars (not cents)
  totalTax: real("total_tax").notNull(),
  totalDiscount: real("total_discount").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), // UTC timestamp
  closedAt: timestamp("closed_at", { withTimezone: true }),
  source: text("source").notNull(), // Source system (Square, manual, etc.)
  isDeleted: boolean("is_deleted").default(false), // Soft deletion flag
  squareData: jsonb("square_data"), // Raw API data
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
});

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

// Order line items
export const orderLineItems = pgTable("order_line_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, {
    onDelete: "cascade"
  }),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull(),
  basePriceMoney: real("base_price_money").notNull(),
  totalMoney: real("total_money").notNull(),
  category: text("category").default("retail"), // Categorization for reporting
  isGiftCard: boolean("is_gift_card").default(false), // Flag for gift card items
  productId: text("product_id"), // Square catalog ID if available
  squareData: jsonb("square_data"),
});

export const insertOrderLineItemSchema = createInsertSchema(orderLineItems).omit({
  id: true,
});

export type InsertOrderLineItem = z.infer<typeof insertOrderLineItemSchema>;
export type OrderLineItem = typeof orderLineItems.$inferSelect;

// Order modifiers
export const orderModifiers = pgTable("order_modifiers", {
  id: serial("id").primaryKey(),
  lineItemId: integer("line_item_id").notNull().references(() => orderLineItems.id, {
    onDelete: "cascade"
  }),
  name: text("name").notNull(),
  basePriceMoney: real("base_price_money"),
  totalPriceMoney: real("total_price_money"),
  squareData: jsonb("square_data"),
});

export const insertOrderModifierSchema = createInsertSchema(orderModifiers).omit({
  id: true,
});

export type InsertOrderModifier = z.infer<typeof insertOrderModifierSchema>;
export type OrderModifier = typeof orderModifiers.$inferSelect;

// Order discounts
export const orderDiscounts = pgTable("order_discounts", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, {
    onDelete: "cascade"
  }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  percentage: real("percentage"),
  amountMoney: real("amount_money"),
  appliedMoney: real("applied_money").notNull(),
  scope: text("scope").notNull(),
  squareData: jsonb("square_data"),
});

export const insertOrderDiscountSchema = createInsertSchema(orderDiscounts).omit({
  id: true,
});

export type InsertOrderDiscount = z.infer<typeof insertOrderDiscountSchema>;
export type OrderDiscount = typeof orderDiscounts.$inferSelect;

// Payments table - replaces transactions with cleaner model
export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  orderId: integer("order_id").references(() => orders.id),
  squareOrderId: text("square_order_id"),
  amount: real("amount").notNull(),
  tipAmount: real("tip_amount").default(0),
  processingFee: real("processing_fee").default(0),
  status: text("status").notNull(),
  source: text("source").notNull(), // CARD, CASH, GIFT_CARD, etc.
  sourceId: integer("source_id").references(() => paymentSources.id),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(), // UTC timestamp
  isRefund: boolean("is_refund").default(false),
  category: text("category").notNull(), // Mapped from order contents
  isGiftCardActivation: boolean("is_gift_card_activation").default(false),
  giftCardId: integer("gift_card_id"), // Links to gift_cards table when applicable
  metadata: jsonb("metadata"),
  squareData: jsonb("square_data"),
});

export const insertPaymentSchema = createInsertSchema(payments).omit({
  id: true,
});

export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof payments.$inferSelect;

// Gift card table - simplified with clear relationships
export const giftCards = pgTable("gift_cards", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  gan: text("gan").notNull(), // Gift Card Account Number
  currentBalance: real("current_balance").notNull(),
  activationAmount: real("activation_amount").notNull(),
  redeemedAmount: real("redeemed_amount").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), // UTC timestamp
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(), // UTC timestamp of activation
  activationOrderId: integer("activation_order_id").references(() => orders.id),
  activationPaymentId: integer("activation_payment_id").references(() => payments.id),
  squareData: jsonb("square_data"),
});

export const insertGiftCardSchema = createInsertSchema(giftCards).omit({
  id: true,
});

export type InsertGiftCard = z.infer<typeof insertGiftCardSchema>;
export type GiftCard = typeof giftCards.$inferSelect;

// Gift card redemptions table - tracks each use of a gift card
export const giftCardRedemptions = pgTable("gift_card_redemptions", {
  id: serial("id").primaryKey(),
  giftCardId: integer("gift_card_id").notNull().references(() => giftCards.id),
  paymentId: integer("payment_id").notNull().references(() => payments.id),
  orderId: integer("order_id").references(() => orders.id),
  amount: real("amount").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(), // UTC timestamp
  squareData: jsonb("square_data"),
});

export const insertGiftCardRedemptionSchema = createInsertSchema(
  giftCardRedemptions,
).omit({
  id: true,
});

export type InsertGiftCardRedemption = z.infer<typeof insertGiftCardRedemptionSchema>;
export type GiftCardRedemption = typeof giftCardRedemptions.$inferSelect;

// Sync state table to track Square data synchronization progress
export const syncState = pgTable("sync_state", {
  id: serial("id").primaryKey(),
  syncType: text("sync_type").notNull(), // orders, payments, gift_cards
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull(),
  cursor: text("cursor").default(""),
  processedCount: integer("processed_count").default(0),
  isComplete: boolean("is_complete").default(false),
  status: text("status").default("pending"),
  errorMessage: text("error_message"),
  lastCheckpoint: jsonb("last_checkpoint"),
});

export const insertSyncStateSchema = createInsertSchema(syncState).omit({
  id: true,
});

export type InsertSyncState = z.infer<typeof insertSyncStateSchema>;
export type SyncState = typeof syncState.$inferSelect;

// Users table
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  isAdmin: boolean("is_admin").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  isAdmin: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Output interfaces for API responses

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

export interface CategoryRevenue {
  category: string;
  amount: number;
  color: string;
}

export interface HourlyRevenue {
  hour: string;
  amount: number;
}

export interface GiftCardSummary {
  soldCount: number;
  soldAmount: number;
  redeemedCount: number;
  redeemedAmount: number;
  averageValue: number;
}