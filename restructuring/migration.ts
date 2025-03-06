/**
 * Database Migration Script
 * 
 * This script handles the migration from the old database schema to the new one.
 * It preserves existing data while implementing the improved structure.
 */
import { db } from '../server/db';
import * as schema from './schema';
import * as oldSchema from '../shared/schema';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';

/**
 * Main migration function
 * 
 * This function performs the following steps:
 * 1. Creates backup tables of existing data
 * 2. Creates new tables according to the new schema
 * 3. Migrates data from old tables to new ones with appropriate transformations
 * 4. Validates the migrated data
 * 
 * @returns A report of the migration results
 */
export async function migrateDatabase(): Promise<{
  success: boolean;
  message: string;
  details: Record<string, any>;
}> {
  // Create a new database connection to avoid conflicts
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    console.log('Starting migration...');
    
    // 1. Create backup tables
    await createBackupTables(pool);
    console.log('Backup tables created successfully');
    
    // 2. Create new schema tables (if they don't exist)
    await createNewTables(pool);
    console.log('New tables created successfully');
    
    // 3. Migrate data
    const migrationReport = await migrateData(pool);
    console.log('Data migration completed:', migrationReport);
    
    // 4. Validate migration
    const validationResult = await validateMigration(pool);
    console.log('Validation result:', validationResult);
    
    return {
      success: true,
      message: 'Migration completed successfully',
      details: {
        ...migrationReport,
        validation: validationResult
      }
    };
  } catch (error) {
    console.error('Migration failed:', error);
    
    return {
      success: false,
      message: `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { error }
    };
  } finally {
    await pool.end();
  }
}

/**
 * Create backup tables for all existing data
 */
async function createBackupTables(pool: Pool): Promise<void> {
  const backupTables = [
    'users',
    'transactions',
    'gift_cards',
    'gift_card_redemptions',
    'sync_state',
    'orders',
    'order_line_items',
    'order_modifiers',
    'order_discounts'
  ];
  
  for (const table of backupTables) {
    const backupTableName = `${table}_backup_${Date.now()}`;
    
    // Check if table exists
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = $1
      )
    `, [table]);
    
    if (tableExists.rows[0].exists) {
      // Create backup table with the same structure and data
      await pool.query(`CREATE TABLE ${backupTableName} AS SELECT * FROM ${table}`);
      console.log(`Created backup table: ${backupTableName}`);
    } else {
      console.log(`Table ${table} doesn't exist, skipping backup`);
    }
  }
}

/**
 * Create new tables according to the new schema
 */
async function createNewTables(pool: Pool): Promise<void> {
  // Define schema creation SQL
  const createPaymentSourcesTable = `
    CREATE TABLE IF NOT EXISTS payment_sources (
      id SERIAL PRIMARY KEY,
      square_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      brand TEXT,
      last4 TEXT,
      gift_card_id INTEGER,
      metadata JSONB DEFAULT '{}'::jsonb
    )
  `;
  
  const createPaymentsTable = `
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      square_id TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      amount REAL NOT NULL DEFAULT 0,
      tip_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      currency TEXT NOT NULL DEFAULT 'USD',
      order_id INTEGER,
      source_id INTEGER REFERENCES payment_sources(id),
      square_order_id TEXT,
      receipt_url TEXT,
      is_gift_card_activation BOOLEAN DEFAULT FALSE,
      gift_card_id INTEGER,
      metadata JSONB DEFAULT '{}'::jsonb
    )
  `;
  
  // Execute schema creation
  await pool.query(createPaymentSourcesTable);
  await pool.query(createPaymentsTable);
  
  // Add foreign key constraints
  // Note: We're adding these separately to avoid circular references
  await pool.query(`
    ALTER TABLE gift_cards 
    ADD COLUMN IF NOT EXISTS activation_payment_id INTEGER,
    ADD CONSTRAINT IF NOT EXISTS fk_gift_card_payment 
      FOREIGN KEY (activation_payment_id) REFERENCES payments(id)
  `);
  
  await pool.query(`
    ALTER TABLE payment_sources 
    ADD CONSTRAINT IF NOT EXISTS fk_payment_source_gift_card 
      FOREIGN KEY (gift_card_id) REFERENCES gift_cards(id)
  `);
  
  await pool.query(`
    ALTER TABLE payments 
    ADD CONSTRAINT IF NOT EXISTS fk_payment_order
      FOREIGN KEY (order_id) REFERENCES orders(id),
    ADD CONSTRAINT IF NOT EXISTS fk_payment_gift_card
      FOREIGN KEY (gift_card_id) REFERENCES gift_cards(id)
  `);
  
  // Add new columns to existing tables if needed
  await pool.query(`
    ALTER TABLE gift_cards 
    ADD COLUMN IF NOT EXISTS activation_amount REAL NOT NULL DEFAULT 0
  `);
  
  await pool.query(`
    ALTER TABLE sync_state 
    ADD COLUMN IF NOT EXISTS total_count INTEGER DEFAULT 0
  `);
}

/**
 * Migrate data from old tables to new ones
 */
async function migrateData(pool: Pool): Promise<Record<string, any>> {
  const report: Record<string, any> = {};
  
  // Migrate transactions to payments
  const migrateTransactions = await pool.query(`
    INSERT INTO payments (
      square_id, status, amount, timestamp, currency, order_id, 
      square_order_id, is_gift_card_activation, gift_card_id, metadata
    )
    SELECT 
      square_id, status, amount, timestamp, 'USD', NULL,
      square_order_id, is_gift_card, gift_card_id, square_data
    FROM transactions
    WHERE NOT EXISTS (
      SELECT 1 FROM payments WHERE payments.square_id = transactions.square_id
    )
    RETURNING id
  `);
  
  report.transactionsMigrated = migrateTransactions.rowCount;
  
  // Create payment sources based on existing transactions with card data
  const migratePaymentSources = await pool.query(`
    WITH card_data AS (
      SELECT DISTINCT 
        t.square_data->>'card_id' as card_id,
        t.square_data->>'card_brand' as brand,
        t.square_data->>'card_last_4' as last4,
        CASE 
          WHEN t.is_gift_card THEN 'gift_card'
          ELSE 'credit_card'
        END as type,
        t.gift_card_id
      FROM transactions t
      WHERE t.square_data->>'card_id' IS NOT NULL
    )
    INSERT INTO payment_sources (
      square_id, type, brand, last4, gift_card_id
    )
    SELECT 
      card_id, type, brand, last4, gift_card_id
    FROM card_data
    WHERE NOT EXISTS (
      SELECT 1 FROM payment_sources WHERE payment_sources.square_id = card_data.card_id
    )
    RETURNING id
  `);
  
  report.paymentSourcesMigrated = migratePaymentSources.rowCount;
  
  // Link payments to payment sources
  const linkPaymentsToSources = await pool.query(`
    UPDATE payments p
    SET source_id = ps.id
    FROM transactions t
    JOIN payment_sources ps ON ps.square_id = t.square_data->>'card_id'
    WHERE p.square_id = t.square_id
    AND p.source_id IS NULL
    AND t.square_data->>'card_id' IS NOT NULL
    RETURNING p.id
  `);
  
  report.paymentsLinkedToSources = linkPaymentsToSources.rowCount;
  
  // Set activation amount for gift cards
  const updateGiftCardActivationAmounts = await pool.query(`
    UPDATE gift_cards gc
    SET activation_amount = GREATEST(
      COALESCE(gc.current_balance, 0) + COALESCE(gc.redeemed_amount, 0),
      COALESCE((
        SELECT MAX(p.amount)
        FROM payments p
        WHERE p.gift_card_id = gc.id
        AND p.is_gift_card_activation = TRUE
      ), 0)
    )
    WHERE gc.activation_amount = 0
    RETURNING gc.id
  `);
  
  report.giftCardsUpdated = updateGiftCardActivationAmounts.rowCount;
  
  // Link gift cards to their activation payments
  const linkGiftCardsToPayments = await pool.query(`
    UPDATE gift_cards gc
    SET activation_payment_id = p.id
    FROM payments p
    WHERE p.gift_card_id = gc.id
    AND p.is_gift_card_activation = TRUE
    AND gc.activation_payment_id IS NULL
    RETURNING gc.id
  `);
  
  report.giftCardsLinkedToPayments = linkGiftCardsToPayments.rowCount;
  
  return report;
}

/**
 * Validate the migrated data to ensure all is correct
 */
async function validateMigration(pool: Pool): Promise<Record<string, any>> {
  const validation: Record<string, any> = {};
  
  // Verify all transactions have corresponding payments
  const transactionCount = await pool.query(`SELECT COUNT(*) FROM transactions`);
  const paymentCount = await pool.query(`SELECT COUNT(*) FROM payments`);
  
  validation.transactionsInOldSchema = parseInt(transactionCount.rows[0].count);
  validation.paymentsInNewSchema = parseInt(paymentCount.rows[0].count);
  validation.allTransactionsMigrated = validation.transactionsInOldSchema <= validation.paymentsInNewSchema;
  
  // Verify all gift cards have activation amounts
  const giftCardCount = await pool.query(`SELECT COUNT(*) FROM gift_cards`);
  const giftCardsWithActivationAmount = await pool.query(`
    SELECT COUNT(*) FROM gift_cards WHERE activation_amount > 0
  `);
  
  validation.totalGiftCards = parseInt(giftCardCount.rows[0].count);
  validation.giftCardsWithActivationAmount = parseInt(giftCardsWithActivationAmount.rows[0].count);
  validation.allGiftCardsHaveActivationAmount = 
    validation.totalGiftCards === validation.giftCardsWithActivationAmount;
  
  // Verify data integrity of gift card activations
  const giftCardValidation = await pool.query(`
    SELECT 
      COUNT(*) as count,
      SUM(CASE WHEN gc.activation_amount > 0 THEN 1 ELSE 0 END) as with_amount,
      SUM(CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END) as with_payment
    FROM gift_cards gc
    LEFT JOIN payments p ON p.id = gc.activation_payment_id
    WHERE gc.is_active = TRUE
  `);
  
  validation.activeGiftCards = parseInt(giftCardValidation.rows[0].count);
  validation.activeGiftCardsWithAmount = parseInt(giftCardValidation.rows[0].with_amount);
  validation.activeGiftCardsWithPayment = parseInt(giftCardValidation.rows[0].with_payment);
  
  return validation;
}