/**
 * Migration Runner
 * 
 * This script provides a CLI to run the database migration.
 * It supports multiple modes: 
 * - dry-run: Check what would happen without making changes
 * - apply: Apply the migration
 * - verify: Verify the state of the database
 */
import { migrateDatabase } from './migration';
import { fixGiftCardActivationAmounts } from './giftCardImprovement';
import { implementImprovements } from './implementImprovements';

async function main() {
  // Parse command-line arguments
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  
  console.log(`Migration Runner - Command: ${command}`);
  
  try {
    switch (command) {
      case 'dry-run':
        await dryRunMigration();
        break;
        
      case 'apply':
        console.log('⚠️ APPLYING MIGRATION - This will modify the database');
        console.log('Press Ctrl+C in the next 5 seconds to cancel...');
        
        // Wait 5 seconds to allow cancellation
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log('Applying migration...');
        const result = await implementImprovements();
        
        console.log('Migration completed successfully');
        console.log('Results:', JSON.stringify(result, null, 2));
        break;
        
      case 'verify':
        console.log('Verifying database state...');
        const verification = await verifyDatabase();
        
        console.log('Verification complete:');
        console.log(JSON.stringify(verification, null, 2));
        break;
        
      case 'fix-gift-cards':
        console.log('Fixing gift card activation amounts...');
        const fixResult = await fixGiftCardActivationAmounts();
        
        console.log('Gift card fix completed:');
        console.log(`Processed ${fixResult.totalProcessed} gift cards`);
        console.log(`Updated ${fixResult.updated} cards`);
        console.log(`${fixResult.alreadyCorrect} cards were already correct`);
        console.log(`${fixResult.withoutActivation} cards without activation`);
        break;
        
      case 'help':
      default:
        printHelp();
        break;
    }
  } catch (error) {
    console.error('Error during migration:', error);
    process.exit(1);
  }
}

/**
 * Perform a dry run of the migration
 */
async function dryRunMigration(): Promise<{
  migrationPlan: Record<string, any>;
  affectedTables: string[];
  dataImpact: Record<string, any>;
}> {
  console.log('Performing dry run migration (no changes will be made)...');
  
  // Get migration plan
  const migrationPlan = await migrateDatabase();
  
  // Show what would happen
  console.log('Migration dry run complete:');
  console.log('Tables that would be affected:');
  
  const affectedTables = Object.keys(migrationPlan.tableResults || {});
  
  for (const table of affectedTables) {
    console.log(` - ${table}`);
  }
  
  console.log('\nData changes that would occur:');
  for (const [table, data] of Object.entries(migrationPlan.tableResults || {})) {
    console.log(` - ${table}: ${JSON.stringify(data)}`);
  }
  
  console.log('\nGift card fixes that would be applied:');
  const giftCardFixes = await fixGiftCardActivationAmounts();
  
  console.log(` - ${giftCardFixes.totalProcessed} gift cards would be processed`);
  console.log(` - ${giftCardFixes.updated} would have activation amounts updated`);
  console.log(` - ${giftCardFixes.alreadyCorrect} already have correct amounts`);
  
  return {
    migrationPlan,
    affectedTables,
    dataImpact: {
      giftCardFixes,
      tableResults: migrationPlan.tableResults
    }
  };
}

/**
 * Verify the current state of the database
 */
async function verifyDatabase(): Promise<{
  status: 'ok' | 'issues';
  issues: Record<string, any>[];
  giftCardStatus: Record<string, any>;
}> {
  // Call verification functions
  const giftCardFixResult = await fixGiftCardActivationAmounts();
  
  // Analyze results to find issues
  const issues: Record<string, any>[] = [];
  
  if (giftCardFixResult.updated > 0) {
    issues.push({
      type: 'gift_card_activation',
      description: 'Some gift cards have incorrect activation amounts',
      affected: giftCardFixResult.updated,
      details: giftCardFixResult
    });
  }
  
  return {
    status: issues.length > 0 ? 'issues' : 'ok',
    issues,
    giftCardStatus: giftCardFixResult
  };
}

function printHelp() {
  console.log(`
Migration Runner - Help
======================

This tool helps you migrate to the new database structure.

Commands:
  dry-run        Run the migration in dry-run mode (no changes)
  apply          Apply the migration to the database
  verify         Verify the current database state
  fix-gift-cards Fix gift card activation amounts only
  help           Show this help message

Examples:
  ts-node run-migration.ts dry-run
  ts-node run-migration.ts apply
  ts-node run-migration.ts verify
  ts-node run-migration.ts fix-gift-cards
  `);
}

// Run the main function
if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}