import { pgTable, text, serial, integer, boolean, timestamp, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Define possible date ranges for filtering
export const dateRangeSchema = z.enum([
  "today",
  "yesterday",
  "last7days",
  "last30days",
  "thisMonth",
  "lastMonth",
  "custom"
]);

export type DateRange = z.infer<typeof dateRangeSchema>;

// Transaction status types
export const transactionStatusSchema = z.enum([
  "completed",
  "refunded",
  "failed",
  "pending"
]);

export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

// Transaction categories
export const categorySchema = z.enum([
  "food",
  "drinks",
  "retail",
  "services",
  "giftCard"
]);

export type Category = z.infer<typeof categorySchema>;

// Main transactions table
export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  amount: real("amount").notNull(),
  categoryId: text("category_id").notNull(),
  status: text("status").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  squareData: jsonb("square_data")
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({
  id: true
});

export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactions.$inferSelect;

// Gift card table
export const giftCards = pgTable("gift_cards", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  amount: real("amount").notNull(),
  redeemedAmount: real("redeemed_amount").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  purchaseDate: timestamp("purchase_date").notNull(),
  squareData: jsonb("square_data")
});

export const insertGiftCardSchema = createInsertSchema(giftCards).omit({
  id: true
});

export type InsertGiftCard = z.infer<typeof insertGiftCardSchema>;
export type GiftCard = typeof giftCards.$inferSelect;

// Gift card redemptions table
export const giftCardRedemptions = pgTable("gift_card_redemptions", {
  id: serial("id").primaryKey(),
  giftCardId: integer("gift_card_id").notNull(),
  amount: real("amount").notNull(),
  transactionId: integer("transaction_id").notNull(),
  timestamp: timestamp("timestamp").notNull()
});

export const insertGiftCardRedemptionSchema = createInsertSchema(giftCardRedemptions).omit({
  id: true
});

export type InsertGiftCardRedemption = z.infer<typeof insertGiftCardRedemptionSchema>;
export type GiftCardRedemption = typeof giftCardRedemptions.$inferSelect;

// Define additional types for the frontend
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

export interface DetailedTransactionBreakdown {
  partywirks: number;
  tripleseat: number;
  tips: number;
  serviceCharges: number;
  taxes: number;
  refunds: number;
  discountsAndComps: number;
  giftCardSales: number;
}

// Keep the users table for authentication
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
