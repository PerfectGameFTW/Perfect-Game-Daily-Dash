/**
 * Migration Runner
 * 
 * This script provides a simpler CommonJS-based migration runner
 * to avoid ESM vs CommonJS compatibility issues.
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  // Parse command-line arguments
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  
  // Create necessary directories
  if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs', { recursive: true });
  }
  
  if (!fs.existsSync('backups')) {
    fs.mkdirSync('backups', { recursive: true });
  }
  
  console.log('MIGRATION RUNNER');
  console.log(`Starting migration runner with command: ${command}`);
  
  // Create database connection
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    switch (command) {
      case 'backup':
        console.log('Creating database backup...');
        const backupName = args[1] || `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await createBackup(pool, backupName);
        break;
        
      case 'migrate':
        console.log('⚠️ APPLYING MIGRATION - This will modify the database');
        console.log('Press Ctrl+C in the next 5 seconds to cancel...');
        
        // Wait 5 seconds to allow cancellation
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log('Applying migration...');
        await migrateDatabase(pool);
        break;
        
      case 'verify':
        console.log('Verifying current database structure...');
        await verifyDatabase(pool);
        break;
        
      case 'help':
      default:
        printHelp();
        break;
    }
  } catch (error) {
    console.error('Error during migration:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

async function createBackup(pool, backupName) {
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
  
  const results = {};
  
  for (const table of backupTables) {
    // Generate a safe backup table name without hyphens
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '_');
    const backupTableName = `${table}_backup_${timestamp}`;
    
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
      await pool.query(`CREATE TABLE "${backupTableName}" AS SELECT * FROM "${table}"`);
      console.log(`Created backup table: ${backupTableName}`);
      
      // Count rows
      const countResult = await pool.query(`SELECT COUNT(*) FROM "${backupTableName}"`);
      const rowCount = parseInt(countResult.rows[0].count);
      results[table] = rowCount;
      
      console.log(`  - Backed up ${rowCount} rows`);
    } else {
      console.log(`Table ${table} doesn't exist, skipping backup`);
      results[table] = 0;
    }
  }
  
  console.log('Backup completed successfully');
  console.log('Summary:', results);
  
  // Write backup metadata
  const metadata = {
    timestamp: new Date().toISOString(),
    name: backupName,
    tables: backupTables,
    results
  };
  
  if (!fs.existsSync('backups')) {
    fs.mkdirSync('backups', { recursive: true });
  }
  
  fs.writeFileSync(
    path.join('backups', `${backupName}.json`),
    JSON.stringify(metadata, null, 2)
  );
  
  console.log(`Backup metadata saved to backups/${backupName}.json`);
  
  return { success: true, results };
}

async function migrateDatabase(pool) {
  console.log('Starting database migration...');
  
  try {
    // Step 1: Create new tables
    await createNewTables(pool);
    console.log('Step 1: New tables created successfully');
    
    // Step 2: Migrate data
    const migrationReport = await migrateData(pool);
    console.log('Step 2: Data migration completed');
    console.log(migrationReport);
    
    // Step 3: Fix gift card activation amounts
    await fixGiftCardActivationAmounts(pool);
    console.log('Step 3: Gift card activation amounts updated');
    
    // Step 4: Validate migration
    const validationResult = await validateMigration(pool);
    console.log('Step 4: Migration validation completed');
    console.log(validationResult);
    
    if (!validationResult.allGiftCardsHaveActivationAmount) {
      console.warn('⚠️ Warning: Not all gift cards have activation amounts');
    }
    
    if (!validationResult.allTransactionsMigrated) {
      console.warn('⚠️ Warning: Not all transactions were migrated to payments');
    }
    
    console.log('Migration completed successfully!');
    
    return {
      success: true,
      details: {
        ...migrationReport,
        validation: validationResult
      }
    };
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

async function createNewTables(pool) {
  // Create the payment_sources table first without any foreign key constraints
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_sources (
      id SERIAL PRIMARY KEY,
      square_id TEXT,
      type TEXT,
      brand TEXT,
      last4 TEXT,
      gift_card_id INTEGER,
      metadata JSONB DEFAULT '{}'::jsonb
    )
  `);
  
  // Create the payments table without any foreign key constraints
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      square_id TEXT,
      status TEXT DEFAULT 'pending',
      amount REAL DEFAULT 0,
      tip_amount REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      currency TEXT DEFAULT 'USD',
      order_id INTEGER,
      source_id INTEGER,
      square_order_id TEXT,
      receipt_url TEXT,
      is_gift_card_activation BOOLEAN DEFAULT FALSE,
      gift_card_id INTEGER,
      metadata JSONB DEFAULT '{}'::jsonb
    )
  `);
  
  // Add new columns to existing tables first
  await pool.query(`
    ALTER TABLE gift_cards 
    ADD COLUMN IF NOT EXISTS activation_payment_id INTEGER
  `);
  
  await pool.query(`
    ALTER TABLE gift_cards 
    ADD COLUMN IF NOT EXISTS activation_amount REAL
  `);
  
  await pool.query(`
    ALTER TABLE sync_state 
    ADD COLUMN IF NOT EXISTS total_count INTEGER DEFAULT 0
  `);
  
  // Let's not add foreign key constraints in the initial migration to avoid
  // potential circular reference issues. We'll add them after data
  // has been migrated.
  
  // Add new columns to existing tables if needed
  // Already added columns earlier
}

async function migrateData(pool) {
  const report = {};
  
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
  
  return report;
}

async function fixGiftCardActivationAmounts(pool) {
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
  
  return {
    giftCardsUpdated: updateGiftCardActivationAmounts.rowCount,
    giftCardsLinkedToPayments: linkGiftCardsToPayments.rowCount
  };
}

async function validateMigration(pool) {
  const validation = {};
  
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

async function verifyDatabase(pool) {
  console.log('Verifying database structure...');
  
  // Check for required tables
  const requiredTables = [
    'users', 'transactions', 'gift_cards', 'gift_card_redemptions',
    'sync_state', 'orders', 'order_line_items', 'order_modifiers',
    'order_discounts', 'payments', 'payment_sources'
  ];
  
  const existingTables = [];
  const missingTables = [];
  
  for (const table of requiredTables) {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = $1
      )
    `, [table]);
    
    if (result.rows[0].exists) {
      existingTables.push(table);
    } else {
      missingTables.push(table);
    }
  }
  
  console.log('Existing tables:', existingTables.join(', '));
  
  if (missingTables.length > 0) {
    console.log('Missing tables:', missingTables.join(', '));
  } else {
    console.log('All required tables exist!');
  }
  
  // Check table counts
  const tableCounts = {};
  
  for (const table of existingTables) {
    const result = await pool.query(`SELECT COUNT(*) FROM ${table}`);
    tableCounts[table] = parseInt(result.rows[0].count);
  }
  
  console.log('Table record counts:');
  for (const [table, count] of Object.entries(tableCounts)) {
    console.log(`  - ${table}: ${count} records`);
  }
  
  // Check gift card activation data
  if (existingTables.includes('gift_cards')) {
    const giftCardStats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN activation_amount > 0 THEN 1 ELSE 0 END) as with_amount,
        AVG(activation_amount) as avg_amount
      FROM gift_cards
    `);
    
    console.log('Gift Card Statistics:');
    console.log(`  - Total Cards: ${giftCardStats.rows[0].total}`);
    console.log(`  - With Activation Amount: ${giftCardStats.rows[0].with_amount}`);
    console.log(`  - Average Activation Amount: $${parseFloat(giftCardStats.rows[0].avg_amount).toFixed(2)}`);
  }
  
  return {
    existingTables,
    missingTables,
    tableCounts
  };
}

function printHelp() {
  console.log(`
Migration Runner - Help
======================

This simplified migration runner helps you migrate the database.

Commands:
  backup <name>   Create a backup of all tables with the given name
  migrate         Apply the migration to the database
  verify          Check the current database structure
  help            Show this help message

Examples:
  node migrate.cjs backup pre-migration
  node migrate.cjs migrate
  node migrate.cjs verify
  `);
}

// Run the main function
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});