/**
 * Integration Script
 * 
 * This script automates the process of integrating the restructured
 * codebase into the main application. It handles file copying,
 * import updates, and validation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface IntegrationOptions {
  dryRun?: boolean;
  backupFiles?: boolean;
  updateImports?: boolean;
  validateTypescript?: boolean;
}

interface FileMapping {
  source: string;
  destination: string;
  required: boolean;
}

/**
 * Main integration function
 * 
 * Copies files from restructuring directory to their proper locations
 * and updates imports as needed.
 */
export async function integrateRestructuring(
  options: IntegrationOptions = {}
): Promise<{
  success: boolean;
  message: string;
  details: Record<string, any>;
}> {
  const {
    dryRun = false,
    backupFiles = true,
    updateImports = true,
    validateTypescript = true
  } = options;
  
  try {
    console.log(`Starting integration ${dryRun ? '(DRY RUN)' : ''}...`);
    
    // Define file mappings - where each restructured file should go
    const fileMappings: FileMapping[] = [
      // Schema
      { source: 'restructuring/schema.ts', destination: 'shared/schema.ts', required: true },
      
      // Core infrastructure
      { source: 'restructuring/dateUtils.ts', destination: 'server/dateUtils.ts', required: true },
      { source: 'restructuring/storage.ts', destination: 'server/storage.ts', required: true },
      { source: 'restructuring/pgStorage.ts', destination: 'server/pgStorage.ts', required: true },
      
      // Services
      { source: 'restructuring/services/orderService.ts', destination: 'server/services/orderService.ts', required: true },
      { source: 'restructuring/services/paymentService.ts', destination: 'server/services/paymentService.ts', required: true },
      { source: 'restructuring/services/giftCardService.ts', destination: 'server/services/giftCardService.ts', required: true },
      { source: 'restructuring/services/syncService.ts', destination: 'server/services/syncService.ts', required: true },
      
      // Routes
      { source: 'restructuring/routes/apiRouter.ts', destination: 'server/routes/apiRouter.ts', required: true },
      
      // Migration scripts
      { source: 'restructuring/migration.ts', destination: 'server/migration.ts', required: false },
      { source: 'restructuring/giftCardImprovement.ts', destination: 'server/giftCardImprovement.ts', required: false },
      { source: 'restructuring/implementImprovements.ts', destination: 'server/implementImprovements.ts', required: false },
      { source: 'restructuring/run-migration.ts', destination: 'server/run-migration.ts', required: false },
      
      // Documentation
      { source: 'restructuring/README.md', destination: 'docs/restructuring.md', required: false }
    ];
    
    // Validate source files exist
    const missingFiles = fileMappings
      .filter(mapping => mapping.required)
      .filter(mapping => !fs.existsSync(mapping.source));
    
    if (missingFiles.length > 0) {
      return {
        success: false,
        message: 'Missing required source files',
        details: {
          missingFiles: missingFiles.map(file => file.source)
        }
      };
    }
    
    // Create backup directory
    const backupDir = path.join('backups', `backup-${Date.now()}`);
    if (backupFiles && !dryRun) {
      fs.mkdirSync(backupDir, { recursive: true });
      console.log(`Created backup directory: ${backupDir}`);
    }
    
    // Create any necessary directories
    const dirsToCreate = Array.from(new Set(
      fileMappings.map(mapping => path.dirname(mapping.destination))
    ));
    
    for (const dir of dirsToCreate) {
      if (!fs.existsSync(dir) && !dryRun) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      }
    }
    
    // Process each file
    const processedFiles: Record<string, any> = {};
    
    for (const mapping of fileMappings) {
      const { source, destination } = mapping;
      
      // Check if destination file exists
      const destinationExists = fs.existsSync(destination);
      
      // Create a backup if needed
      if (destinationExists && backupFiles && !dryRun) {
        const backupFile = path.join(backupDir, destination);
        const backupFileDir = path.dirname(backupFile);
        
        fs.mkdirSync(backupFileDir, { recursive: true });
        fs.copyFileSync(destination, backupFile);
      }
      
      // Copy the file
      if (!dryRun) {
        fs.copyFileSync(source, destination);
      }
      
      processedFiles[destination] = {
        source,
        existed: destinationExists,
        backed_up: destinationExists && backupFiles
      };
      
      console.log(`${dryRun ? 'Would copy' : 'Copied'} ${source} to ${destination}`);
    }
    
    // Update imports if needed
    if (updateImports && !dryRun) {
      await updateFileImports();
    }
    
    // Validate TypeScript if needed
    if (validateTypescript && !dryRun) {
      try {
        const { stdout, stderr } = await execAsync('npx tsc --noEmit');
        console.log('TypeScript validation successful');
      } catch (error: any) {
        console.warn('TypeScript validation found issues:', error.stderr);
        // Continue despite TS errors - they'll need manual fixing
      }
    }
    
    return {
      success: true,
      message: dryRun 
        ? 'Dry run completed successfully' 
        : 'Integration completed successfully',
      details: {
        processedFiles,
        backupDir: backupFiles ? backupDir : null
      }
    };
  } catch (error) {
    console.error('Integration failed:', error);
    
    return {
      success: false,
      message: `Integration failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { error }
    };
  }
}

/**
 * Update imports in files that reference the restructured modules
 */
async function updateFileImports(): Promise<void> {
  // Get all TS files
  const tsFiles = await findTsFiles('.');
  
  // Import mappings to update
  const importMappings = [
    { from: '../shared/schema', to: '../shared/schema' }, // No change, just for completeness
    { from: './dateUtils', to: './dateUtils' }, // No change, new file in same location
    { from: './storage', to: './storage' }, // No change, new file in same location
    { from: './pgStorage', to: './pgStorage' }, // No change, new file in same location
    
    // Service imports
    { from: './fixGiftCardActivationAmounts', to: './services/giftCardService' },
    { from: './fixGiftCardActivationsFromOrders', to: './services/giftCardService' },
    { from: './fixGiftCardPaymentLink', to: './services/giftCardService' },
    { from: './updateGiftCardActivationFromOrders', to: './services/giftCardService' },
    { from: './updateGiftCardActivationFromTransactions', to: './services/giftCardService' },
    { from: './updateGiftCardAmountsFromOrders', to: './services/giftCardService' },
    { from: './updateRedemptionData', to: './services/giftCardService' },
    
    // API imports
    { from: './routes', to: './routes/apiRouter' }
  ];
  
  // Files to skip (don't update these)
  const skipFiles = [
    'node_modules',
    'dist',
    'build',
    'restructuring'
  ];
  
  // Process each file
  for (const file of tsFiles) {
    // Skip excluded directories
    if (skipFiles.some(skip => file.includes(skip))) {
      continue;
    }
    
    const content = fs.readFileSync(file, 'utf8');
    let newContent = content;
    
    // Replace imports
    for (const mapping of importMappings) {
      const importRegex = new RegExp(`from\\s+['"](${mapping.from})['"]`, 'g');
      newContent = newContent.replace(importRegex, `from '${mapping.to}'`);
    }
    
    // Only write if changed
    if (newContent !== content) {
      fs.writeFileSync(file, newContent);
      console.log(`Updated imports in ${file}`);
    }
  }
}

/**
 * Find all TypeScript files in a directory recursively
 */
async function findTsFiles(dir: string): Promise<string[]> {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  const tsFiles: string[] = [];
  
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      // Skip node_modules
      if (file.name === 'node_modules' || file.name === '.git') {
        continue;
      }
      
      const subFiles = await findTsFiles(fullPath);
      tsFiles.push(...subFiles);
    } else if (file.name.endsWith('.ts') || file.name.endsWith('.tsx')) {
      tsFiles.push(fullPath);
    }
  }
  
  return tsFiles;
}

// Main entry point if run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  
  // Parse options
  const options: IntegrationOptions = {
    dryRun: args.includes('--dry-run'),
    backupFiles: !args.includes('--no-backup'),
    updateImports: !args.includes('--no-imports'),
    validateTypescript: !args.includes('--no-validate')
  };
  
  integrateRestructuring(options)
    .then(result => {
      if (result.success) {
        console.log('Integration completed successfully');
        console.log(JSON.stringify(result.details, null, 2));
        process.exit(0);
      } else {
        console.error('Integration failed:', result.message);
        console.error(JSON.stringify(result.details, null, 2));
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('Unexpected error:', error);
      process.exit(1);
    });
}