/**
 * Test Migration Script
 * 
 * This script validates the current database structure and performs a dry-run
 * of the migration to ensure everything will work properly before applying changes.
 */

const { Pool } = require('pg');
require('dotenv').config();

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    console.log('Database Migration Test Script');
    console.log('============================');
    
    // 1. Verify current database structure
    await verifyCurrentDatabase(pool);
    
    // 2. Check if new tables already exist
    await checkNewTables(pool);
    
    // 3. Validate sample data
    await validateSampleData(pool);
    
    console.log('\nMigration validation complete!');
    console.log('The database appears to be ready for migration.');
  } catch (error) {
    console.error('Error during migration test:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

async function verifyCurrentDatabase(pool) {
  console.log('\nVerifying current database structure...');
  
  // Check for required tables
  const requiredTables = [
    'users', 'transactions', 'gift_cards', 'gift_card_redemptions',
    'sync_state', 'orders', 'order_line_items', 'order_modifiers',
    'order_discounts'
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
  
  console.log('- Existing tables:', existingTables.join(', '));
  
  if (missingTables.length > 0) {
    console.log('- Missing required tables:', missingTables.join(', '));
    throw new Error('Missing required tables. Migration cannot proceed.');
  } else {
    console.log('- All required tables exist ✓');
  }
  
  // Check table counts
  const tableCounts = {};
  
  for (const table of existingTables) {
    const result = await pool.query(`SELECT COUNT(*) FROM ${table}`);
    tableCounts[table] = parseInt(result.rows[0].count);
  }
  
  console.log('\nTable record counts:');
  for (const [table, count] of Object.entries(tableCounts)) {
    console.log(`  - ${table}: ${count} records`);
  }
  
  // Check gift card data
  if (existingTables.includes('gift_cards')) {
    const giftCardStats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) as with_balance,
        AVG(amount) as avg_balance
      FROM gift_cards
    `);
    
    console.log('\nGift Card Statistics:');
    console.log(`  - Total Cards: ${giftCardStats.rows[0].total}`);
    console.log(`  - With Balance: ${giftCardStats.rows[0].with_balance}`);
    console.log(`  - Average Balance: $${parseFloat(giftCardStats.rows[0].avg_balance).toFixed(2)}`);
  }
  
  // Check transaction data
  if (existingTables.includes('transactions')) {
    const transactionStats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN category_id = 'giftCard' THEN 1 ELSE 0 END) as gift_card_count,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_count
      FROM transactions
    `);
    
    console.log('\nTransaction Statistics:');
    console.log(`  - Total Transactions: ${transactionStats.rows[0].total}`);
    console.log(`  - Gift Card Transactions: ${transactionStats.rows[0].gift_card_count}`);
    console.log(`  - Completed Transactions: ${transactionStats.rows[0].completed_count}`);
  }
}

async function checkNewTables(pool) {
  console.log('\nChecking if new tables already exist...');
  
  // Check for new tables that will be created
  const newTables = ['payments', 'payment_sources'];
  
  const existingNewTables = [];
  
  for (const table of newTables) {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = $1
      )
    `, [table]);
    
    if (result.rows[0].exists) {
      existingNewTables.push(table);
    }
  }
  
  if (existingNewTables.length > 0) {
    console.log(`- Warning: The following new tables already exist: ${existingNewTables.join(', ')}`);
    console.log('  These tables will be used as-is during migration.');
    
    // Check the structure of existing tables
    for (const table of existingNewTables) {
      const columns = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = $1
      `, [table]);
      
      console.log(`\n- Structure of existing '${table}' table:`);
      columns.rows.forEach(column => {
        console.log(`  - ${column.column_name} (${column.data_type})`);
      });
    }
  } else {
    console.log('- New tables will be created during migration ✓');
  }
  
  // Check for gift card columns that will be added
  console.log('\nChecking gift_cards table structure...');
  
  const giftCardColumns = await pool.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'gift_cards'
  `);
  
  const existingColumns = giftCardColumns.rows.map(row => row.column_name);
  
  const requiredNewColumns = ['activation_amount', 'activation_payment_id'];
  const missingColumns = requiredNewColumns.filter(col => !existingColumns.includes(col));
  
  if (missingColumns.length > 0) {
    console.log(`- The following columns will be added to gift_cards: ${missingColumns.join(', ')} ✓`);
  } else {
    console.log('- All required columns already exist in gift_cards table ✓');
  }
}

async function validateSampleData(pool) {
  console.log('\nValidating sample data for migration...');
  
  // Check gift card data integrity
  const giftCardSample = await pool.query(`
    SELECT id, gan, is_active, amount, redeemed_amount 
    FROM gift_cards 
    ORDER BY id 
    LIMIT 5
  `);
  
  console.log('\nSample Gift Cards:');
  giftCardSample.rows.forEach(card => {
    console.log(`  - ID: ${card.id}, GAN: ${card.gan}, Active: ${card.is_active}, Balance: $${card.amount}, Redeemed: $${card.redeemed_amount}`);
  });
  
  // Check transaction data integrity
  const transactionSample = await pool.query(`
    SELECT id, square_id, status, amount, is_gift_card, gift_card_id
    FROM transactions 
    WHERE is_gift_card = TRUE
    ORDER BY id 
    LIMIT 5
  `);
  
  console.log('\nSample Gift Card Transactions:');
  transactionSample.rows.forEach(tx => {
    console.log(`  - ID: ${tx.id}, Square ID: ${tx.square_id}, Status: ${tx.status}, Amount: $${tx.amount}, Gift Card ID: ${tx.gift_card_id}`);
  });
  
  // Test the extraction of transaction data that will be used for payments
  const extractedData = await pool.query(`
    SELECT 
      t.id as transaction_id,
      t.square_id,
      t.status,
      t.amount,
      t.square_data->>'card_id' as card_id,
      t.square_data->>'card_brand' as card_brand,
      t.square_data->>'card_last_4' as card_last4
    FROM transactions t
    WHERE t.square_data->>'card_id' IS NOT NULL
    ORDER BY t.id
    LIMIT 5
  `);
  
  console.log('\nSample Payment Source Data Extraction:');
  extractedData.rows.forEach(row => {
    console.log(`  - Transaction: ${row.transaction_id}, Card ID: ${row.card_id}, Brand: ${row.card_brand}, Last 4: ${row.card_last4}`);
  });
  
  // Count expected migration results
  const transactionCount = await pool.query(`SELECT COUNT(*) FROM transactions`);
  const giftCardTransactions = await pool.query(`SELECT COUNT(*) FROM transactions WHERE is_gift_card = TRUE`);
  const uniqueCardIds = await pool.query(`
    SELECT COUNT(DISTINCT square_data->>'card_id') 
    FROM transactions 
    WHERE square_data->>'card_id' IS NOT NULL
  `);
  
  console.log('\nExpected Migration Results:');
  console.log(`  - Payments to create: ${transactionCount.rows[0].count}`);
  console.log(`  - Gift card payments: ${giftCardTransactions.rows[0].count}`);
  console.log(`  - Payment sources to create: ${uniqueCardIds.rows[0].count}`);
}

// Run the main function
main();