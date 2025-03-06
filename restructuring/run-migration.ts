/**
 * Migration Runner
 * 
 * This script provides a CLI to run the database migration.
 * It supports multiple modes: 
 * - dry-run: Check what would happen without making changes
 * - apply: Apply the migration
 * - verify: Verify the state of the database
 * - validate: Run data validation
 * - backup: Create a database backup
 * - optimize: Run performance optimizations
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { migrateDatabase } from './migration';
import { fixGiftCardActivationAmounts } from './giftCardImprovement';
import { implementImprovements } from './implementImprovements';
import { migrationLogger } from './tools/logger';
import { validateDatabaseData, generateValidationReport } from './tools/data-validator';
import { createBackup, rollback } from './tools/rollback';
import { optimizeDatabase } from './tools/performance-optimizations';

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
  
  migrationLogger.section('MIGRATION RUNNER', 'runner');
  migrationLogger.info(`Starting migration runner with command: ${command}`, 'runner');
  
  // Create database connection
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    switch (command) {
      case 'dry-run':
        await dryRunMigration(pool);
        break;
        
      case 'apply':
        migrationLogger.warn('APPLYING MIGRATION - This will modify the database', 'runner');
        console.log('⚠️ APPLYING MIGRATION - This will modify the database');
        console.log('Press Ctrl+C in the next 5 seconds to cancel...');
        
        // Wait 5 seconds to allow cancellation
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        migrationLogger.info('Applying migration...', 'runner');
        const result = await implementImprovements({ skipBackup: false, skipOptimization: false });
        
        migrationLogger.info('Migration completed successfully', 'runner', result);
        console.log('Migration completed successfully');
        console.log('Results:', JSON.stringify(result, null, 2));
        break;
        
      case 'verify':
        migrationLogger.info('Verifying database state...', 'runner');
        const verification = await verifyDatabase(pool);
        
        migrationLogger.info('Verification complete', 'runner', verification);
        console.log('Verification complete:');
        console.log(JSON.stringify(verification, null, 2));
        break;
        
      case 'validate':
        migrationLogger.info('Running database validation...', 'runner');
        const validationResult = await validateDatabaseData(pool, {
          validateAll: true,
          outputPath: path.join('logs', 'validation.json')
        });
        
        console.log(generateValidationReport(validationResult));
        
        if (!validationResult.valid) {
          migrationLogger.warn('Validation found issues', 'runner', {
            errors: validationResult.errors.length,
            warnings: validationResult.warnings.length
          });
          process.exit(1);
        } else {
          migrationLogger.info('Validation passed', 'runner');
          console.log('Validation passed successfully!');
        }
        break;
        
      case 'backup':
        migrationLogger.info('Creating database backup...', 'runner');
        const backupResult = await createBackup(pool, {
          notes: args[1] || 'Manual backup',
          interactive: false
        });
        
        if (backupResult.success) {
          migrationLogger.info('Backup created successfully', 'runner', {
            path: backupResult.backupPath,
            tables: backupResult.tables.length
          });
          console.log(`Backup created successfully: ${backupResult.backupPath}`);
          console.log(`Backed up ${backupResult.tables.length} tables`);
        } else {
          migrationLogger.error('Backup failed', 'runner', backupResult.errors);
          console.error('Backup failed');
          process.exit(1);
        }
        break;
        
      case 'rollback':
        const backupId = args[1];
        if (!backupId) {
          console.error('Error: Missing backup ID');
          console.log('Usage: ts-node run-migration.ts rollback <backup-id> [--dry-run]');
          process.exit(1);
        }
        
        const dryRunRollback = args.includes('--dry-run');
        
        migrationLogger.warn(
          `Rolling back to backup ${backupId}${dryRunRollback ? ' (DRY RUN)' : ''}`,
          'runner'
        );
        
        console.log(`⚠️ ROLLING BACK TO BACKUP: ${backupId}${dryRunRollback ? ' (DRY RUN)' : ''}`);
        console.log('This will REPLACE current data with backup data.');
        console.log('Press Ctrl+C in the next 10 seconds to cancel...');
        
        // Longer wait for rollback
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        const rollbackResult = await rollback(pool, {
          backupId,
          dryRun: dryRunRollback,
          interactive: false,
          force: true
        });
        
        if (rollbackResult.success) {
          migrationLogger.info('Rollback completed successfully', 'runner', {
            tables: rollbackResult.restoredTables
          });
          console.log('Rollback completed successfully');
          console.log(`Restored ${rollbackResult.restoredTables.length} tables`);
        } else {
          migrationLogger.error('Rollback failed', 'runner', rollbackResult.errors);
          console.error('Rollback failed');
          process.exit(1);
        }
        break;
        
      case 'optimize':
        const dryRunOptimize = args.includes('--dry-run');
        const skipIndexing = args.includes('--skip-indexing');
        const skipVacuum = args.includes('--skip-vacuum');
        const skipStats = args.includes('--skip-stats');
        const tables = args
          .filter(arg => arg.startsWith('--table='))
          .map(arg => arg.split('=')[1]);
        
        migrationLogger.info(
          `Optimizing database${dryRunOptimize ? ' (DRY RUN)' : ''}`,
          'runner',
          { skipIndexing, skipVacuum, skipStats, tables }
        );
        
        const optimizationResults = await optimizeDatabase(pool, {
          tables,
          skipIndexing,
          skipVacuum,
          skipStats,
          dryRun: dryRunOptimize
        });
        
        // Find summary result
        const summary = optimizationResults.find(r => r.operation === 'optimization_summary');
        
        if (summary && summary.details?.statComparison?.summary) {
          const { summary: statsSum } = summary.details.statComparison;
          console.log('\nSize Changes:');
          console.log(`Before: ${statsSum.totalSizeBeforeFormatted}`);
          console.log(`After:  ${statsSum.totalSizeAfterFormatted}`);
          console.log(`Change: ${statsSum.totalSizeChangeFormatted} (${statsSum.totalSizeChangePercent})`);
        }
        
        const successCount = optimizationResults.filter(r => r.success).length;
        const failureCount = optimizationResults.filter(r => !r.success).length;
        
        migrationLogger.info('Optimization completed', 'runner', {
          successful: successCount,
          failed: failureCount
        });
        
        console.log(`Optimization completed: ${successCount} successful, ${failureCount} failed operations`);
        break;
        
      case 'fix-gift-cards':
        migrationLogger.info('Fixing gift card activation amounts...', 'runner');
        const fixResult = await fixGiftCardActivationAmounts();
        
        migrationLogger.info('Gift card fix completed', 'runner', fixResult);
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
    migrationLogger.error('Error during migration:', 'runner', error);
    console.error('Error during migration:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

/**
 * Perform a dry run of the migration
 */
async function dryRunMigration(pool: Pool): Promise<{
  migrationPlan: Record<string, any>;
  validationResults: Record<string, any>;
  affectedTables: string[];
  dataImpact: Record<string, any>;
}> {
  migrationLogger.info('Performing dry run migration (no changes will be made)...', 'runner');
  console.log('Performing dry run migration (no changes will be made)...');
  
  // Validate database before
  migrationLogger.info('Running validation check...', 'runner');
  const validationResults = await validateDatabaseData(pool, { validateAll: true });
  
  // Get migration plan
  migrationLogger.info('Getting migration plan...', 'runner');
  const migrationPlan = await migrateDatabase();
  
  // Show what would happen
  console.log('Migration dry run complete:');
  console.log('Tables that would be affected:');
  
  const affectedTables = Object.keys(migrationPlan.details || {});
  
  for (const table of affectedTables) {
    console.log(` - ${table}`);
  }
  
  console.log('\nData changes that would occur:');
  for (const [table, data] of Object.entries(migrationPlan.details || {})) {
    console.log(` - ${table}: ${JSON.stringify(data)}`);
  }
  
  migrationLogger.info('Checking gift card fixes...', 'runner');
  console.log('\nGift card fixes that would be applied:');
  const giftCardFixes = await fixGiftCardActivationAmounts();
  
  console.log(` - ${giftCardFixes.totalProcessed} gift cards would be processed`);
  console.log(` - ${giftCardFixes.updated} would have activation amounts updated`);
  console.log(` - ${giftCardFixes.alreadyCorrect} already have correct amounts`);
  
  migrationLogger.info('Dry run completed', 'runner', {
    affectedTables,
    giftCardFixes: {
      totalProcessed: giftCardFixes.totalProcessed,
      updated: giftCardFixes.updated
    }
  });
  
  return {
    migrationPlan,
    validationResults: {
      errors: validationResults.errors.length,
      warnings: validationResults.warnings.length,
      isValid: validationResults.valid
    },
    affectedTables,
    dataImpact: {
      giftCardFixes,
      migrationDetails: migrationPlan.details
    }
  };
}

/**
 * Verify the current state of the database
 */
async function verifyDatabase(pool: Pool): Promise<{
  status: 'ok' | 'issues';
  validation: {
    isValid: boolean;
    errors: number;
    warnings: number;
  };
  issues: Record<string, any>[];
  giftCardStatus: Record<string, any>;
}> {
  migrationLogger.info('Starting database verification...', 'runner');
  
  // Run validation
  migrationLogger.info('Running database validation...', 'runner');
  const validationResults = await validateDatabaseData(pool, { 
    validateAll: true,
    outputPath: path.join('logs', 'verification.json')
  });
  
  // Call verification functions
  migrationLogger.info('Checking gift card activation amounts...', 'runner');
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
  
  if (!validationResults.valid) {
    issues.push({
      type: 'data_validation',
      description: 'Data validation found issues',
      affected: validationResults.errors.length,
      details: {
        errors: validationResults.errors.length,
        warnings: validationResults.warnings.length
      }
    });
  }
  
  const status = issues.length > 0 ? 'issues' : 'ok';
  
  migrationLogger.info(`Verification complete: ${status}`, 'runner', { 
    issueCount: issues.length
  });
  
  return {
    status,
    validation: {
      isValid: validationResults.valid,
      errors: validationResults.errors.length,
      warnings: validationResults.warnings.length
    },
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
  validate       Validate database data integrity
  backup         Create a database backup
  rollback       Roll back to a previous backup
  optimize       Run database performance optimizations
  fix-gift-cards Fix gift card activation amounts only
  help           Show this help message

Options:
  --dry-run              Simulate the operation without making changes (for rollback, optimize)
  --skip-indexing        Skip index creation (for optimize)
  --skip-vacuum          Skip VACUUM operation (for optimize)
  --skip-stats           Skip statistics update (for optimize)
  --table=<name>         Specify a table (for optimize, can be used multiple times)

Examples:
  ts-node run-migration.ts dry-run
  ts-node run-migration.ts apply
  ts-node run-migration.ts verify
  ts-node run-migration.ts validate
  ts-node run-migration.ts backup "Pre-production backup"
  ts-node run-migration.ts rollback backup-2023-01-01 --dry-run
  ts-node run-migration.ts optimize --dry-run
  ts-node run-migration.ts fix-gift-cards
  `);
}

// Run the main function
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});