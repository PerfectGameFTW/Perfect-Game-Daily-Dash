/**
 * Migration Runner
 * 
 * This script provides a CLI to run the database migration.
 * It supports multiple modes: 
 * - dry-run: Check what would happen without making changes
 * - apply: Apply the migration
 * - verify: Verify the state of the database
 */
import { implementImprovements } from './implementImprovements';
import { migrateDatabase } from './migration';
import { fixGiftCardActivationAmounts, verifyGiftCardData } from './giftCardImprovement';
import fs from 'fs';
import path from 'path';

// CLI Arguments
const args = process.argv.slice(2);
const mode = args[0] || 'dry-run';
const outputPath = args[1] || './migration-report.json';

async function main() {
  try {
    console.log(`Running migration in ${mode} mode...`);
    
    let result;
    
    switch (mode) {
      case 'dry-run':
        // In dry-run mode, we check what would happen but don't make changes
        console.log('Performing dry run of database migration...');
        // Implement a dry-run version that doesn't actually change the database
        result = await dryRunMigration();
        break;
        
      case 'apply':
        // In apply mode, we actually perform the migration
        console.log('Applying database migration...');
        result = await implementImprovements();
        break;
        
      case 'verify':
        // In verify mode, we just check the current state
        console.log('Verifying database state...');
        result = await verifyDatabase();
        break;
        
      case 'fix-gift-cards':
        // In fix-gift-cards mode, we just fix gift card data
        console.log('Fixing gift card data...');
        const fixResult = await fixGiftCardActivationAmounts();
        await verifyGiftCardData();
        result = { success: true, message: 'Gift card fix completed', details: fixResult };
        break;
        
      default:
        console.error(`Unknown mode: ${mode}`);
        console.log('Available modes: dry-run, apply, verify, fix-gift-cards');
        process.exit(1);
    }
    
    // Write the result to a JSON file
    fs.writeFileSync(
      path.resolve(outputPath),
      JSON.stringify(result, null, 2)
    );
    
    console.log(`Report written to ${outputPath}`);
    
    if (result.success) {
      console.log('Operation completed successfully');
      process.exit(0);
    } else {
      console.error('Operation failed:', result.message);
      process.exit(1);
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    process.exit(1);
  }
}

/**
 * Perform a dry run of the migration
 */
async function dryRunMigration(): Promise<{
  success: boolean;
  message: string;
  details: Record<string, any>;
}> {
  // We can't actually perform a full dry run without additional logic in the migration code
  // So instead, we'll just analyze the database and report on what would change
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // Check if new tables already exist
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('payment_sources', 'payments')
    `);
    
    const existingTables = tablesResult.rows.map(row => row.table_name);
    
    // Check gift card data
    const giftCardResult = await pool.query(`
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN activation_amount > 0 THEN 1 ELSE 0 END) AS with_activation,
        SUM(CASE WHEN activation_amount = 0 THEN 1 ELSE 0 END) AS without_activation
      FROM gift_cards
    `);
    
    const giftCardStats = giftCardResult.rows[0];
    
    // Check transaction data
    const transactionResult = await pool.query(`
      SELECT COUNT(*) FROM transactions
    `);
    
    const transactionCount = parseInt(transactionResult.rows[0].count);
    
    return {
      success: true,
      message: 'Dry run completed',
      details: {
        existingTables,
        newTablesToCreate: ['payment_sources', 'payments'].filter(t => !existingTables.includes(t)),
        giftCardStats: {
          total: parseInt(giftCardStats.total),
          withActivation: parseInt(giftCardStats.with_activation),
          withoutActivation: parseInt(giftCardStats.without_activation),
          percentComplete: (parseInt(giftCardStats.with_activation) / parseInt(giftCardStats.total) * 100).toFixed(2) + '%'
        },
        transactionsToMigrate: transactionCount,
        estimatedTimeInSeconds: 10 + transactionCount * 0.01 // Rough estimate based on transaction count
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Dry run failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { error }
    };
  } finally {
    await pool.end();
  }
}

/**
 * Verify the current state of the database
 */
async function verifyDatabase(): Promise<{
  success: boolean;
  message: string;
  details: Record<string, any>;
}> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // Check if new tables exist
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('payment_sources', 'payments', 'gift_cards', 'gift_card_redemptions', 'transactions')
    `);
    
    const existingTables = tablesResult.rows.map(row => row.table_name);
    
    // Check if transactions have been migrated to payments
    let transactionsMigrated = false;
    let migrationProgress = 0;
    
    if (existingTables.includes('payments') && existingTables.includes('transactions')) {
      const transactionCount = await pool.query(`SELECT COUNT(*) FROM transactions`);
      const paymentCount = await pool.query(`SELECT COUNT(*) FROM payments`);
      
      transactionsMigrated = parseInt(paymentCount.rows[0].count) >= parseInt(transactionCount.rows[0].count);
      migrationProgress = parseInt(transactionCount.rows[0].count) > 0 
        ? (parseInt(paymentCount.rows[0].count) / parseInt(transactionCount.rows[0].count) * 100).toFixed(2) + '%'
        : '0%';
    }
    
    // Check gift card data
    let giftCardStats = null;
    
    if (existingTables.includes('gift_cards')) {
      const giftCardResult = await pool.query(`
        SELECT 
          COUNT(*) AS total,
          SUM(CASE WHEN activation_amount > 0 THEN 1 ELSE 0 END) AS with_activation,
          SUM(CASE WHEN activation_amount = 0 THEN 1 ELSE 0 END) AS without_activation
        FROM gift_cards
      `);
      
      giftCardStats = {
        total: parseInt(giftCardResult.rows[0].total),
        withActivation: parseInt(giftCardResult.rows[0].with_activation),
        withoutActivation: parseInt(giftCardResult.rows[0].without_activation),
        percentComplete: (parseInt(giftCardResult.rows[0].with_activation) / parseInt(giftCardResult.rows[0].total) * 100).toFixed(2) + '%'
      };
    }
    
    return {
      success: true,
      message: 'Database verification completed',
      details: {
        existingTables,
        transactionsMigrated,
        migrationProgress,
        giftCardStats
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { error }
    };
  } finally {
    await pool.end();
  }
}

// Import Pool from pg - we need to add this import at the top
import { Pool } from 'pg';

// Run the main function
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});