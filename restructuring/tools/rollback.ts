/**
 * Migration Rollback System
 * 
 * This tool provides an emergency rollback capability for database migrations.
 * It can restore from backups created during the migration process.
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// Backup metadata type
interface BackupMetadata {
  timestamp: string;
  tables: string[];
  createdBy: string;
  notes?: string;
}

interface RollbackOptions {
  backupId?: string;
  targetTables?: string[];
  dryRun?: boolean;
  interactive?: boolean;
  force?: boolean;
}

interface RollbackResult {
  success: boolean;
  restoredTables: string[];
  errors: Error[];
  details: Record<string, any>;
}

/**
 * Roll back to a previous database state
 * 
 * This function restores database tables from a backup.
 */
export async function rollback(
  pool: Pool,
  options: RollbackOptions = {}
): Promise<RollbackResult> {
  const {
    backupId,
    targetTables = [],
    dryRun = false,
    interactive = true,
    force = false
  } = options;
  
  // Results and tracking variables
  const restoredTables: string[] = [];
  const errors: Error[] = [];
  const details: Record<string, any> = {};
  
  try {
    // 1. Locate the backup directory
    const backupsDir = path.join('backups');
    
    if (!fs.existsSync(backupsDir)) {
      throw new Error('No backups directory found');
    }
    
    // 2. Get available backups
    const backups = fs
      .readdirSync(backupsDir)
      .filter(dir => fs.statSync(path.join(backupsDir, dir)).isDirectory())
      .filter(dir => dir.startsWith('backup-'));
    
    if (backups.length === 0) {
      throw new Error('No backups found');
    }
    
    // 3. Select the backup to use
    let selectedBackup: string;
    
    if (backupId) {
      // Use specified backup
      selectedBackup = backups.find(b => b === backupId || b.includes(backupId));
      
      if (!selectedBackup) {
        throw new Error(`Backup with ID "${backupId}" not found`);
      }
    } else {
      // Use most recent backup
      selectedBackup = backups.sort().reverse()[0];
      
      // Confirm if interactive
      if (interactive && !force) {
        const confirmed = await confirmAction(
          `Restore from most recent backup (${selectedBackup})? [y/N] `
        );
        
        if (!confirmed) {
          throw new Error('Rollback cancelled by user');
        }
      }
    }
    
    const backupPath = path.join(backupsDir, selectedBackup);
    console.log(`Using backup: ${backupPath}`);
    
    // 4. Get metadata if exists
    let metadata: BackupMetadata | undefined;
    const metadataPath = path.join(backupPath, 'metadata.json');
    
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      console.log(`Backup metadata: ${JSON.stringify(metadata, null, 2)}`);
    } else {
      console.warn('No metadata found for this backup');
    }
    
    // 5. Get tables in the backup
    const tablesInBackup = fs
      .readdirSync(backupPath)
      .filter(file => file.endsWith('.sql'))
      .map(file => path.basename(file, '.sql'));
    
    // 6. Determine which tables to restore
    const tablesToRestore = targetTables.length > 0
      ? targetTables.filter(t => tablesInBackup.includes(t))
      : tablesInBackup;
    
    if (tablesToRestore.length === 0) {
      throw new Error('No tables to restore');
    }
    
    console.log(`Tables to restore: ${tablesToRestore.join(', ')}`);
    
    // 7. Confirm the rollback if interactive
    if (interactive && !force) {
      const confirmed = await confirmAction(
        `Restore ${tablesToRestore.length} tables from backup? ` +
        `${dryRun ? '(DRY RUN) ' : ''}` +
        `This will REPLACE current data. [y/N] `
      );
      
      if (!confirmed) {
        throw new Error('Rollback cancelled by user');
      }
    }
    
    // 8. Perform the rollback
    await pool.query('BEGIN');
    
    try {
      for (const table of tablesToRestore) {
        const backupFilePath = path.join(backupPath, `${table}.sql`);
        
        if (!fs.existsSync(backupFilePath)) {
          console.warn(`Backup file for table ${table} not found, skipping`);
          continue;
        }
        
        console.log(`Restoring table: ${table}${dryRun ? ' (DRY RUN)' : ''}`);
        
        if (!dryRun) {
          // Read backup SQL
          const sql = fs.readFileSync(backupFilePath, 'utf8');
          
          // Execute the SQL
          try {
            // First drop the existing table
            await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
            
            // Then restore from backup
            await pool.query(sql);
            
            restoredTables.push(table);
          } catch (error) {
            console.error(`Error restoring table ${table}:`, error);
            errors.push(error);
            throw error; // Propagate to trigger rollback
          }
        } else {
          // In dry run mode, just record it
          restoredTables.push(table);
        }
      }
      
      if (!dryRun) {
        await pool.query('COMMIT');
        console.log('Rollback committed successfully');
      } else {
        // In dry run mode, roll back the transaction
        await pool.query('ROLLBACK');
        console.log('Dry run completed, rolled back transaction');
      }
      
    } catch (error) {
      // If any error occurred, roll back the transaction
      await pool.query('ROLLBACK');
      console.error('Rollback failed, transaction rolled back');
      throw error;
    }
    
    // 9. Return the result
    return {
      success: errors.length === 0,
      restoredTables,
      errors,
      details: {
        backupId: selectedBackup,
        metadata,
        dryRun
      }
    };
    
  } catch (error) {
    console.error('Rollback error:', error);
    return {
      success: false,
      restoredTables,
      errors: [error],
      details: { error: error.message }
    };
  }
}

/**
 * Create a backup of database tables
 */
export async function createBackup(
  pool: Pool,
  options: {
    tables?: string[];
    notes?: string;
    interactive?: boolean;
  } = {}
): Promise<{
  success: boolean;
  backupPath?: string;
  tables: string[];
  errors: Error[];
}> {
  const { tables = [], notes = '', interactive = true } = options;
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `backup-${timestamp}`;
  const backupDir = path.join('backups', backupId);
  const errors: Error[] = [];
  const backedUpTables: string[] = [];
  
  try {
    // 1. Create backup directory
    fs.mkdirSync(backupDir, { recursive: true });
    
    // 2. Determine which tables to backup
    let tablesToBackup: string[] = [];
    
    if (tables.length > 0) {
      tablesToBackup = tables;
    } else {
      // Get all tables from the database
      const tableResult = await pool.query(`
        SELECT tablename FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
      `);
      
      tablesToBackup = tableResult.rows.map(row => row.tablename);
    }
    
    if (tablesToBackup.length === 0) {
      throw new Error('No tables to backup');
    }
    
    console.log(`Tables to backup: ${tablesToBackup.join(', ')}`);
    
    // 3. Confirm the backup if interactive
    if (interactive) {
      const confirmed = await confirmAction(
        `Create backup of ${tablesToBackup.length} tables? [y/N] `
      );
      
      if (!confirmed) {
        throw new Error('Backup cancelled by user');
      }
    }
    
    // 4. Backup each table
    for (const table of tablesToBackup) {
      try {
        console.log(`Backing up table: ${table}`);
        
        // Get table schema and data as SQL
        const result = await pool.query(`
          SELECT 
            pg_dump_table_def('${table}') as schema,
            pg_dump_table_data('${table}') as data
        `);
        
        const schema = result.rows[0]?.schema;
        const data = result.rows[0]?.data;
        
        if (!schema) {
          throw new Error(`Failed to get schema for table ${table}`);
        }
        
        // Write to file
        const backupFilePath = path.join(backupDir, `${table}.sql`);
        fs.writeFileSync(backupFilePath, schema + '\n' + (data || ''), 'utf8');
        
        backedUpTables.push(table);
      } catch (error) {
        console.error(`Error backing up table ${table}:`, error);
        errors.push(error);
      }
    }
    
    // 5. Write metadata
    const metadata: BackupMetadata = {
      timestamp: new Date().toISOString(),
      tables: backedUpTables,
      createdBy: 'restructuring-tools',
      notes
    };
    
    fs.writeFileSync(
      path.join(backupDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
      'utf8'
    );
    
    return {
      success: errors.length === 0,
      backupPath: backupDir,
      tables: backedUpTables,
      errors
    };
    
  } catch (error) {
    console.error('Backup error:', error);
    return {
      success: false,
      tables: backedUpTables,
      errors: [error]
    };
  }
}

/**
 * Helper function to check if the pg_dump functions exist
 */
export async function ensurePgDumpFunctions(pool: Pool): Promise<boolean> {
  try {
    // Check if the functions exist
    const result = await pool.query(`
      SELECT COUNT(*) as count FROM pg_proc 
      WHERE proname IN ('pg_dump_table_def', 'pg_dump_table_data')
    `);
    
    if (result.rows[0].count === 2) {
      return true;
    }
    
    // Create the functions
    await pool.query(`
      CREATE OR REPLACE FUNCTION pg_dump_table_def(p_table_name text) 
      RETURNS text AS $$
      DECLARE
        v_table_ddl text;
        column_record record;
        constraint_record record;
        index_record record;
      BEGIN
        -- Get table definition
        SELECT 
          'CREATE TABLE ' || quote_ident(c.relname) || ' (' 
        INTO v_table_ddl
        FROM pg_catalog.pg_class c
        LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = p_table_name
        AND n.nspname = 'public';
        
        -- Get columns
        FOR column_record IN 
          SELECT 
            quote_ident(a.attname) as column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
            CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE '' END as not_null,
            CASE 
              WHEN a.atthasdef THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid, true)
              ELSE ''
            END as default_value
          FROM pg_catalog.pg_attribute a
          LEFT JOIN pg_catalog.pg_attrdef d ON (d.adrelid = a.attrelid AND d.adnum = a.attnum)
          JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
          JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
          WHERE c.relname = p_table_name
          AND n.nspname = 'public'
          AND a.attnum > 0
          AND NOT a.attisdropped
          ORDER BY a.attnum
        LOOP
          v_table_ddl := v_table_ddl || E'\\n  ' || 
            column_record.column_name || ' ' || 
            column_record.data_type || ' ' || 
            column_record.not_null || 
            column_record.default_value || ',';
        END LOOP;
        
        -- Remove trailing comma
        v_table_ddl := substring(v_table_ddl, 1, length(v_table_ddl) - 1);
        
        -- Add closing parenthesis
        v_table_ddl := v_table_ddl || E'\\n);';
        
        -- Add primary key
        FOR constraint_record IN
          SELECT
            conname as constraint_name,
            pg_get_constraintdef(oid) as constraint_def
          FROM pg_constraint
          WHERE conrelid = (
            SELECT oid FROM pg_class WHERE relname = p_table_name AND relnamespace = (
              SELECT oid FROM pg_namespace WHERE nspname = 'public'
            )
          )
          AND contype = 'p'
        LOOP
          v_table_ddl := v_table_ddl || E'\\n\\nALTER TABLE ' || 
            quote_ident(p_table_name) || ' ADD CONSTRAINT ' || 
            quote_ident(constraint_record.constraint_name) || ' ' || 
            constraint_record.constraint_def || ';';
        END LOOP;
        
        RETURN v_table_ddl;
      END;
      $$ LANGUAGE plpgsql;
      
      CREATE OR REPLACE FUNCTION pg_dump_table_data(p_table_name text)
      RETURNS text AS $$
      DECLARE
        v_data text;
        v_row_count integer;
      BEGIN
        -- Check if table has data
        EXECUTE 'SELECT COUNT(*) FROM ' || quote_ident(p_table_name) INTO v_row_count;
        
        IF v_row_count = 0 THEN
          RETURN '';
        END IF;
        
        -- Build INSERT statements
        v_data := '';
        FOR v_row IN EXECUTE 'SELECT * FROM ' || quote_ident(p_table_name)
        LOOP
          v_data := v_data || E'\\nINSERT INTO ' || quote_ident(p_table_name) || ' VALUES (';
          
          -- Build values list
          v_values := '';
          FOR i IN 1..array_length(v_row, 1)
          LOOP
            IF v_row[i] IS NULL THEN
              v_values := v_values || 'NULL, ';
            ELSIF pg_typeof(v_row[i]) IN ('text'::regtype, 'varchar'::regtype, 'char'::regtype, 'date'::regtype, 'timestamp'::regtype, 'timestamptz'::regtype) THEN
              v_values := v_values || quote_literal(v_row[i]) || ', ';
            ELSE
              v_values := v_values || v_row[i] || ', ';
            END IF;
          END LOOP;
          
          -- Remove trailing comma and space
          v_values := substring(v_values, 1, length(v_values) - 2);
          
          v_data := v_data || v_values || ');';
        END LOOP;
        
        RETURN v_data;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE WARNING 'Error generating INSERT statements for %: %', p_table_name, SQLERRM;
          RETURN '';
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    return true;
  } catch (error) {
    console.error('Error ensuring pg_dump functions:', error);
    return false;
  }
}

/**
 * Helper function to prompt for confirmation
 */
async function confirmAction(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise<boolean>(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// Run directly if called as script
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  
  // Parse options
  const backupId = args.find(arg => arg.startsWith('--backup='))?.split('=')[1];
  const tables = args
    .filter(arg => arg.startsWith('--table='))
    .map(arg => arg.split('=')[1]);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const notes = args.find(arg => arg.startsWith('--notes='))?.split('=')[1] || '';
  
  // Create database connection
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  switch (command) {
    case 'backup':
      // Create a backup
      createBackup(pool, { tables, notes })
        .then(result => {
          if (result.success) {
            console.log(`Backup created successfully: ${result.backupPath}`);
            console.log(`Backed up tables: ${result.tables.join(', ')}`);
          } else {
            console.error('Backup completed with errors:', result.errors);
          }
          process.exit(result.success ? 0 : 1);
        })
        .catch(error => {
          console.error('Backup failed:', error);
          process.exit(1);
        })
        .finally(() => {
          pool.end();
        });
      break;
      
    case 'rollback':
      // Perform a rollback
      rollback(pool, { backupId, targetTables: tables, dryRun, force })
        .then(result => {
          if (result.success) {
            console.log('Rollback completed successfully');
            console.log(`Restored tables: ${result.restoredTables.join(', ')}`);
          } else {
            console.error('Rollback failed:', result.errors);
          }
          process.exit(result.success ? 0 : 1);
        })
        .catch(error => {
          console.error('Rollback failed:', error);
          process.exit(1);
        })
        .finally(() => {
          pool.end();
        });
      break;
      
    case 'list':
      // List available backups
      try {
        const backupsDir = path.join('backups');
        
        if (!fs.existsSync(backupsDir)) {
          console.log('No backups directory found');
          process.exit(0);
        }
        
        const backups = fs
          .readdirSync(backupsDir)
          .filter(dir => fs.statSync(path.join(backupsDir, dir)).isDirectory())
          .filter(dir => dir.startsWith('backup-'))
          .sort()
          .reverse();
        
        if (backups.length === 0) {
          console.log('No backups found');
        } else {
          console.log(`Found ${backups.length} backups:`);
          
          for (const backup of backups) {
            const metadataPath = path.join(backupsDir, backup, 'metadata.json');
            let metadata: BackupMetadata | undefined;
            
            if (fs.existsSync(metadataPath)) {
              metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            }
            
            console.log(`- ${backup}`);
            
            if (metadata) {
              console.log(`  Created: ${metadata.timestamp}`);
              console.log(`  Tables: ${metadata.tables.length}`);
              
              if (metadata.notes) {
                console.log(`  Notes: ${metadata.notes}`);
              }
            }
          }
        }
        
        process.exit(0);
      } catch (error) {
        console.error('Error listing backups:', error);
        process.exit(1);
      } finally {
        pool.end();
      }
      break;
      
    case 'setup':
      // Setup the necessary database functions
      ensurePgDumpFunctions(pool)
        .then(success => {
          if (success) {
            console.log('Database functions created successfully');
          } else {
            console.error('Failed to create database functions');
          }
          process.exit(success ? 0 : 1);
        })
        .catch(error => {
          console.error('Setup failed:', error);
          process.exit(1);
        })
        .finally(() => {
          pool.end();
        });
      break;
      
    case 'help':
    default:
      console.log(`
Rollback Tool - Help
===================

Commands:
  backup    Create a backup of database tables
  rollback  Roll back to a previous backup
  list      List available backups
  setup     Setup necessary database functions
  help      Show this help message

Options:
  --backup=<id>    Specify which backup to use for rollback
  --table=<name>   Specify a table to backup/restore (can be used multiple times)
  --dry-run        Show what would happen without making changes
  --force          Skip confirmation prompts
  --notes=<text>   Add notes to a backup

Examples:
  ts-node rollback.ts backup --table=users --table=orders --notes="Before migration"
  ts-node rollback.ts rollback --backup=backup-2023-01-01 --dry-run
  ts-node rollback.ts list
  ts-node rollback.ts setup
      `);
      process.exit(0);
  }
}