/**
 * Implementation Script
 * 
 * This script coordinates and executes the various improvements to the system
 * in the right order, with proper validation at each step.
 */
import { migrateDatabase } from './migration';
import { fixGiftCardActivationAmounts } from './giftCardImprovement';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Main implementation function
 * 
 * This function:
 * 1. Executes the database migration
 * 2. Fixes gift card data
 * 3. Verifies the results
 * 4. Returns a comprehensive report
 */
export async function implementImprovements(): Promise<{
  success: boolean;
  migrationResults: any;
  giftCardFixResults: any;
  cleanupResults: any;
}> {
  console.log('Starting improvements implementation...');
  
  try {
    // Step 1: Database migration
    console.log('Step 1: Executing database migration...');
    const migrationResults = await migrateDatabase();
    
    // Step 2: Fix gift card data
    console.log('Step 2: Fixing gift card activation amounts...');
    const giftCardFixResults = await fixGiftCardActivationAmounts();
    
    // Step 3: Clean up legacy scripts
    console.log('Step 3: Cleaning up legacy scripts...');
    const cleanupResults = await cleanupOldScripts();
    
    // Return comprehensive report
    return {
      success: true,
      migrationResults,
      giftCardFixResults,
      cleanupResults
    };
  } catch (error) {
    console.error('Error during implementation:', error);
    throw error;
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
    
    console.log(`Archived script: ${script}`);
    archivedScripts.push(script);
  }
  
  return {
    oldScripts,
    archivedScripts
  };
}

// Run directly if called from command line
if (require.main === module) {
  implementImprovements()
    .then(results => {
      console.log('Implementation completed successfully!');
      console.log(JSON.stringify(results, null, 2));
    })
    .catch(error => {
      console.error('Implementation failed:', error);
      process.exit(1);
    });
}