/**
 * Implementation Script
 * 
 * This script coordinates and executes the various improvements to the system
 * in the right order, with proper validation at each step.
 */
import { migrateDatabase } from './migration';
import { fixGiftCardActivationAmounts } from './giftCardImprovement';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { migrationLogger, LogLevel } from './tools/logger';
import { validateDatabaseData, generateValidationReport } from './tools/data-validator';
import { createBackup } from './tools/rollback';
import { optimizeDatabase } from './tools/performance-optimizations';

/**
 * Main implementation function
 * 
 * This function:
 * 1. Executes the database migration
 * 2. Fixes gift card data
 * 3. Verifies the results
 * 4. Returns a comprehensive report
 */
export async function implementImprovements(options: {
  skipBackup?: boolean;
  skipOptimization?: boolean;
  dryRun?: boolean;
} = {}): Promise<{
  success: boolean;
  migrationResults: any;
  giftCardFixResults: any;
  cleanupResults: any;
  validationResults: any;
  optimizationResults?: any;
}> {
  const {
    skipBackup = false,
    skipOptimization = false,
    dryRun = false
  } = options;
  
  migrationLogger.section('IMPLEMENTATION IMPROVEMENTS', 'main');
  migrationLogger.info(
    `Starting improvements implementation${dryRun ? ' (DRY RUN)' : ''}...`,
    'main',
    { options }
  );
  
  // Create database connection
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // Step 0: Create database backup if not skipped
    if (!skipBackup && !dryRun) {
      migrationLogger.section('DATABASE BACKUP', 'backup');
      migrationLogger.info('Creating database backup...', 'backup');
      
      const backupResult = await createBackup(pool, {
        notes: 'Pre-migration backup',
        interactive: false
      });
      
      if (!backupResult.success) {
        migrationLogger.error(
          'Backup failed, aborting migration',
          'backup',
          backupResult.errors
        );
        throw new Error('Backup failed, cannot proceed with migration');
      }
      
      migrationLogger.info(
        `Backup completed successfully: ${backupResult.backupPath}`,
        'backup',
        { tables: backupResult.tables }
      );
    } else if (skipBackup) {
      migrationLogger.warn('Skipping database backup', 'backup');
    } else {
      migrationLogger.info('Skipping database backup (dry run)', 'backup');
    }
    
    // Step 1: Validate database before migration
    migrationLogger.section('PRE-MIGRATION VALIDATION', 'validation');
    migrationLogger.info('Validating database before migration...', 'validation');
    
    const preValidationResults = await validateDatabaseData(pool, {
      validateAll: true,
      outputPath: path.join('logs', 'pre-migration-validation.json')
    });
    
    if (!preValidationResults.valid) {
      migrationLogger.warn(
        'Pre-migration validation found issues',
        'validation',
        {
          errorCount: preValidationResults.errors.length,
          warningCount: preValidationResults.warnings.length
        }
      );
      
      // Log the full report
      migrationLogger.info(
        'Pre-migration validation report:\n' + 
        generateValidationReport(preValidationResults),
        'validation'
      );
    } else {
      migrationLogger.info(
        'Pre-migration validation passed successfully',
        'validation',
        preValidationResults.summary
      );
    }
    
    // Step 2: Database migration
    migrationLogger.section('DATABASE MIGRATION', 'migration');
    migrationLogger.info(
      `Executing database migration${dryRun ? ' (DRY RUN)' : ''}...`,
      'migration'
    );
    
    const migrationResults = dryRun
      ? { success: true, message: 'Dry run, no changes made' }
      : await migrateDatabase();
    
    migrationLogger.info(
      'Database migration completed',
      'migration',
      migrationResults
    );
    
    // Step 3: Fix gift card data
    migrationLogger.section('GIFT CARD DATA FIX', 'giftcard');
    migrationLogger.info(
      `Fixing gift card activation amounts${dryRun ? ' (DRY RUN)' : ''}...`,
      'giftcard'
    );
    
    const giftCardFixResults = dryRun
      ? { 
          totalProcessed: 0, 
          updated: 0, 
          alreadyCorrect: 0, 
          withoutActivation: 0,
          message: 'Dry run, no changes made' 
        }
      : await fixGiftCardActivationAmounts();
    
    migrationLogger.info(
      'Gift card fix completed',
      'giftcard',
      giftCardFixResults
    );
    
    // Step 4: Validate database after migration
    migrationLogger.section('POST-MIGRATION VALIDATION', 'validation');
    migrationLogger.info('Validating database after migration...', 'validation');
    
    const postValidationResults = await validateDatabaseData(pool, {
      validateAll: true,
      outputPath: path.join('logs', 'post-migration-validation.json')
    });
    
    if (!postValidationResults.valid) {
      migrationLogger.warn(
        'Post-migration validation found issues',
        'validation',
        {
          errorCount: postValidationResults.errors.length,
          warningCount: postValidationResults.warnings.length
        }
      );
      
      // Log the full report
      migrationLogger.info(
        'Post-migration validation report:\n' + 
        generateValidationReport(postValidationResults),
        'validation'
      );
    } else {
      migrationLogger.info(
        'Post-migration validation passed successfully',
        'validation',
        postValidationResults.summary
      );
    }
    
    // Step 5: Performance optimization
    let optimizationResults = undefined;
    
    if (!skipOptimization && !dryRun) {
      migrationLogger.section('PERFORMANCE OPTIMIZATION', 'optimization');
      migrationLogger.info('Optimizing database performance...', 'optimization');
      
      optimizationResults = await optimizeDatabase(pool);
      
      migrationLogger.info(
        'Performance optimization completed',
        'optimization',
        { 
          operations: optimizationResults.length,
          success: optimizationResults.filter(r => r.success).length
        }
      );
    } else if (skipOptimization) {
      migrationLogger.warn('Skipping performance optimization', 'optimization');
    } else {
      migrationLogger.info('Skipping performance optimization (dry run)', 'optimization');
    }
    
    // Step 6: Clean up legacy scripts
    migrationLogger.section('CLEANUP', 'cleanup');
    migrationLogger.info(
      `Cleaning up legacy scripts${dryRun ? ' (DRY RUN)' : ''}...`,
      'cleanup'
    );
    
    const cleanupResults = dryRun
      ? { oldScripts: [], archivedScripts: [], message: 'Dry run, no changes made' }
      : await cleanupOldScripts();
    
    migrationLogger.info(
      'Cleanup completed',
      'cleanup',
      cleanupResults
    );
    
    // Save log summary
    const summaryPath = path.join('logs', 'migration-summary.log');
    fs.writeFileSync(
      summaryPath,
      migrationLogger.generateSummary(),
      'utf8'
    );
    
    migrationLogger.info(
      `Migration summary written to ${summaryPath}`,
      'main'
    );
    
    // Return comprehensive report
    return {
      success: true,
      migrationResults,
      giftCardFixResults,
      cleanupResults,
      validationResults: {
        pre: preValidationResults.summary,
        post: postValidationResults.summary,
        isValid: postValidationResults.valid
      },
      optimizationResults
    };
  } catch (error) {
    migrationLogger.error('Error during implementation:', 'main', error);
    throw error;
  } finally {
    await pool.end();
  }
}

/**
 * Clean up old scripts that are no longer needed
 */
async function cleanupOldScripts(): Promise<{
  oldScripts: string[];
  archivedScripts: string[];
}> {
  // List of old scripts that are no longer needed
  const oldScripts = [
    'fixGiftCardActivationAmounts.ts',
    'fixGiftCardActivationsFromOrders.ts',
    'fixGiftCardPaymentLink.ts',
    'updateGiftCardActivationFromOrders.ts',
    'updateGiftCardActivationFromTransactions.ts',
    'updateGiftCardAmountsFromOrders.ts',
    'updateRedemptionData.ts',
    'checkGiftCardTotals.ts',
    'testGiftCardUpdate.ts'
  ];
  
  // Create backup directory
  const archiveDir = path.join('server', 'archived_scripts');
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }
  
  // Archive each script
  const archivedScripts: string[] = [];
  
  for (const script of oldScripts) {
    const oldPath = path.join('server', script);
    
    // Skip if file doesn't exist
    if (!fs.existsSync(oldPath)) {
      continue;
    }
    
    // Archive the file
    const archivePath = path.join(archiveDir, script);
    fs.copyFileSync(oldPath, archivePath);
    fs.unlinkSync(oldPath);
    
    migrationLogger.info(`Archived script: ${script}`, 'cleanup');
    archivedScripts.push(script);
  }
  
  return {
    oldScripts,
    archivedScripts
  };
}

// Run directly if called from command line
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipBackup = args.includes('--skip-backup');
  const skipOptimization = args.includes('--skip-optimization');
  
  // Create logs directory if it doesn't exist
  if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs', { recursive: true });
  }
  
  implementImprovements({
    dryRun,
    skipBackup,
    skipOptimization
  })
    .then(results => {
      migrationLogger.section('IMPLEMENTATION COMPLETED', 'main');
      migrationLogger.info('Implementation completed successfully!', 'main', results);
      console.log(JSON.stringify(results, null, 2));
    })
    .catch(error => {
      migrationLogger.error('Implementation failed:', 'main', error);
      console.error('Implementation failed:', error);
      process.exit(1);
    });
}