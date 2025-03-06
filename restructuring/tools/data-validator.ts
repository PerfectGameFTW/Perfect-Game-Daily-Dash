/**
 * Database Data Validator
 * 
 * This tool performs comprehensive validation of database data
 * to ensure integrity before and after migration.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../schema';
import * as fs from 'fs';
import * as path from 'path';

// Define validation result type
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  summary: {
    tablesChecked: number;
    recordsChecked: number;
    errorCount: number;
    warningCount: number;
    timeTaken: number;
  };
}

interface ValidationError {
  table: string;
  record?: number | string;
  field?: string;
  message: string;
  severity: 'high' | 'medium' | 'low';
}

interface ValidationWarning {
  table: string;
  record?: number | string;
  field?: string;
  message: string;
  recommendation?: string;
}

/**
 * Validate database data
 * 
 * This function performs comprehensive validation of the database data
 * to ensure integrity and consistency.
 * 
 * @param pool Database connection pool
 * @param options Validation options
 * @returns ValidationResult with details of validation results
 */
export async function validateDatabaseData(
  pool: Pool,
  options: {
    outputPath?: string;
    validateAll?: boolean;
    specificTables?: string[];
    recordLimit?: number;
  } = {}
): Promise<ValidationResult> {
  const startTime = Date.now();
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  let tablesChecked = 0;
  let recordsChecked = 0;

  const {
    outputPath,
    validateAll = false,
    specificTables = [],
    recordLimit = 1000
  } = options;

  // Connect to database using Drizzle
  const db = drizzle(pool, { schema });

  // Tables to validate
  const tablesToValidate = validateAll
    ? Object.keys(schema)
      .filter(key => typeof schema[key]?._.name === 'string')
      .map(key => (schema[key] as any)._.name)
    : specificTables;

  console.log(`Validating ${tablesToValidate.length} tables...`);
  
  // Validate each table
  for (const tableName of tablesToValidate) {
    try {
      console.log(`Validating table: ${tableName}`);
      
      // Get table schema if it exists
      const tableSchema = Object.values(schema).find(t => 
        typeof t?._ === 'object' && t._.name === tableName
      );
      
      if (!tableSchema) {
        console.warn(`No schema found for table: ${tableName}, skipping...`);
        warnings.push({
          table: tableName,
          message: `No schema definition found for table`,
          recommendation: 'Add table schema to shared/schema.ts'
        });
        continue;
      }
      
      // 1. Check table existence
      const tableExistsResult = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        ) as exists
      `, [tableName]);
      
      if (!tableExistsResult.rows[0].exists) {
        errors.push({
          table: tableName,
          message: `Table does not exist in database`,
          severity: 'high'
        });
        continue;
      }
      
      // 2. Check table structure
      const tableColumns = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
      `, [tableName]);
      
      // Report any schema mismatches
      const columnsInDb = new Set(tableColumns.rows.map(r => r.column_name));
      const expectedColumns = Object.keys((tableSchema as any)._).filter(k => 
        k !== '_' && k !== '$inferSelect' && k !== '$inferInsert'
      );
      
      for (const col of expectedColumns) {
        if (!columnsInDb.has(col)) {
          errors.push({
            table: tableName,
            field: col,
            message: `Column exists in schema but not in database`,
            severity: 'high'
          });
        }
      }
      
      // 3. Query the data for validation
      const query = `SELECT * FROM "${tableName}" LIMIT $1`;
      const result = await pool.query(query, [recordLimit]);
      
      tablesChecked++;
      recordsChecked += result.rowCount;
      
      // 4. Validate individual rows
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];
        
        // Check for null values in required fields
        for (const col of tableColumns.rows) {
          if (col.is_nullable === 'NO' && row[col.column_name] === null) {
            errors.push({
              table: tableName,
              record: row.id || i,
              field: col.column_name,
              message: `Required field is null`,
              severity: 'medium'
            });
          }
        }
        
        // Check data type consistency
        for (const col of tableColumns.rows) {
          const value = row[col.column_name];
          if (value !== null) {
            // Validate timestamps
            if (col.data_type.includes('timestamp') && value instanceof Date) {
              if (isNaN(value.getTime())) {
                errors.push({
                  table: tableName,
                  record: row.id || i,
                  field: col.column_name,
                  message: `Invalid timestamp value`,
                  severity: 'medium'
                });
              }
            }
            
            // Validate numbers
            if ((col.data_type === 'integer' || col.data_type === 'numeric') && 
                typeof value === 'number' && isNaN(value)) {
              errors.push({
                table: tableName,
                record: row.id || i,
                field: col.column_name,
                message: `Invalid numeric value`,
                severity: 'medium'
              });
            }
          }
        }
        
        // Check relational integrity for foreign keys
        if (tableName === 'order_line_items' && row.order_id) {
          const orderExists = await pool.query(
            `SELECT EXISTS(SELECT 1 FROM orders WHERE id = $1)`, 
            [row.order_id]
          );
          if (!orderExists.rows[0].exists) {
            errors.push({
              table: tableName,
              record: row.id || i,
              field: 'order_id',
              message: `References non-existent order ID: ${row.order_id}`,
              severity: 'high'
            });
          }
        }
        
        // Check gift card specific validations
        if (tableName === 'gift_cards') {
          // Check activation amount consistency
          if (row.activation_amount === null && row.state === 'ACTIVE') {
            warnings.push({
              table: tableName,
              record: row.id,
              field: 'activation_amount',
              message: `Active gift card without activation amount`,
              recommendation: 'Run fixGiftCardActivationAmounts to populate missing values'
            });
          }
        }
      }
      
    } catch (error) {
      console.error(`Error validating table ${tableName}:`, error);
      errors.push({
        table: tableName,
        message: `Validation error: ${error.message}`,
        severity: 'high'
      });
    }
  }
  
  // Create summary
  const timeTaken = Date.now() - startTime;
  const summary = {
    tablesChecked,
    recordsChecked,
    errorCount: errors.length,
    warningCount: warnings.length,
    timeTaken
  };
  
  const result: ValidationResult = {
    valid: errors.length === 0,
    errors,
    warnings,
    summary
  };
  
  // Write to output file if specified
  if (outputPath) {
    const outputDir = path.dirname(outputPath);
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(
      outputPath,
      JSON.stringify(result, null, 2),
      'utf8'
    );
    
    console.log(`Validation results written to: ${outputPath}`);
  }
  
  return result;
}

/**
 * Generate a user-friendly report from validation results
 */
export function generateValidationReport(results: ValidationResult): string {
  const { errors, warnings, summary } = results;
  
  let report = `
=========================================
DATABASE VALIDATION REPORT
=========================================

SUMMARY
-------
Tables Checked: ${summary.tablesChecked}
Records Checked: ${summary.recordsChecked}
Errors: ${summary.errorCount}
Warnings: ${summary.warningCount}
Time Taken: ${summary.timeTaken}ms
Status: ${results.valid ? 'PASSED' : 'FAILED'}

`;

  if (errors.length > 0) {
    report += `
ERRORS
------
`;
    
    for (const error of errors) {
      report += `[${error.severity.toUpperCase()}] ${error.table}`;
      
      if (error.record) {
        report += ` - Record: ${error.record}`;
      }
      
      if (error.field) {
        report += ` - Field: ${error.field}`;
      }
      
      report += `\n  ${error.message}\n\n`;
    }
  }

  if (warnings.length > 0) {
    report += `
WARNINGS
--------
`;
    
    for (const warning of warnings) {
      report += `${warning.table}`;
      
      if (warning.record) {
        report += ` - Record: ${warning.record}`;
      }
      
      if (warning.field) {
        report += ` - Field: ${warning.field}`;
      }
      
      report += `\n  ${warning.message}`;
      
      if (warning.recommendation) {
        report += `\n  Recommendation: ${warning.recommendation}`;
      }
      
      report += `\n\n`;
    }
  }
  
  return report;
}

// Run directly if called as script
if (require.main === module) {
  const args = process.argv.slice(2);
  const outputPath = args.find(arg => arg.startsWith('--output='))?.split('=')[1];
  const validateAll = args.includes('--all');
  const tables = args
    .filter(arg => arg.startsWith('--table='))
    .map(arg => arg.split('=')[1]);
  
  // Create database connection
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  validateDatabaseData(pool, {
    outputPath,
    validateAll,
    specificTables: tables,
  })
    .then(results => {
      console.log(generateValidationReport(results));
      
      if (!results.valid) {
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('Validation failed:', error);
      process.exit(1);
    })
    .finally(() => {
      pool.end();
    });
}