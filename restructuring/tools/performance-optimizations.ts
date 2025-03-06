/**
 * Performance Optimizations
 * 
 * This module provides database performance optimizations for improved
 * query speed and resource utilization.
 */
import { Pool } from 'pg';
import { migrationLogger } from './logger';

interface OptimizationResult {
  operation: string;
  tableName?: string;
  success: boolean;
  details?: any;
  elapsedMs?: number;
}

interface IndexInfo {
  tableName: string;
  columnName: string;
  indexName?: string;
  unique?: boolean;
  method?: 'btree' | 'hash' | 'gist' | 'gin';
  includedColumns?: string[];
  condition?: string;
}

interface TableStatsInfo {
  tableName: string;
  rowCount: number;
  sizeBytes: number;
  sizeFormatted: string;
  hasAutovacuum: boolean;
  lastAnalyzed?: Date;
}

/**
 * Apply database performance optimizations
 * 
 * @param pool PostgreSQL connection pool
 * @param options Optimization options
 * @returns Results of optimization operations
 */
export async function optimizeDatabase(
  pool: Pool,
  options: {
    tables?: string[];
    skipIndexing?: boolean;
    skipVacuum?: boolean;
    skipStats?: boolean;
    dryRun?: boolean;
  } = {}
): Promise<OptimizationResult[]> {
  const {
    tables = [],
    skipIndexing = false,
    skipVacuum = false,
    skipStats = false,
    dryRun = false
  } = options;
  
  const results: OptimizationResult[] = [];
  
  try {
    // Log the start of optimization
    migrationLogger.section('Database Performance Optimization', 'optimizer');
    migrationLogger.info(
      `Starting database optimization${dryRun ? ' (DRY RUN)' : ''}`,
      'optimizer',
      { options }
    );
    
    // Get tables to optimize
    const tablesToOptimize = tables.length > 0
      ? tables
      : await getAllTables(pool);
    
    migrationLogger.info(
      `Will optimize ${tablesToOptimize.length} tables`,
      'optimizer',
      { tables: tablesToOptimize }
    );
    
    // Get table statistics before optimization
    const beforeStats = await getTableStats(pool, tablesToOptimize);
    
    // Create missing indexes
    if (!skipIndexing) {
      const indexResults = await createMissingIndexes(pool, tablesToOptimize, dryRun);
      results.push(...indexResults);
    }
    
    // Run VACUUM ANALYZE
    if (!skipVacuum) {
      const vacuumResults = await vacuumTables(pool, tablesToOptimize, dryRun);
      results.push(...vacuumResults);
    }
    
    // Update table statistics
    if (!skipStats) {
      const statsResults = await updateTableStats(pool, tablesToOptimize, dryRun);
      results.push(...statsResults);
    }
    
    // Get table statistics after optimization
    const afterStats = await getTableStats(pool, tablesToOptimize);
    
    // Compare before and after statistics
    const statComparison = compareTableStats(beforeStats, afterStats);
    
    migrationLogger.info(
      'Database optimization completed',
      'optimizer',
      {
        tablesOptimized: tablesToOptimize.length,
        operationsPerformed: results.length,
        statComparison
      }
    );
    
    // Add summary result
    results.push({
      operation: 'optimization_summary',
      success: true,
      details: {
        tablesOptimized: tablesToOptimize.length,
        statComparison
      }
    });
    
    return results;
    
  } catch (error) {
    migrationLogger.error(
      'Database optimization failed',
      'optimizer',
      error
    );
    
    results.push({
      operation: 'optimization_error',
      success: false,
      details: {
        error: error.message,
        stack: error.stack
      }
    });
    
    return results;
  }
}

/**
 * Get all tables in the database
 */
async function getAllTables(pool: Pool): Promise<string[]> {
  const timer = migrationLogger.startTimer('getAllTables');
  
  try {
    const result = await pool.query(`
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    
    const tables = result.rows.map(row => row.tablename);
    
    timer.stop('optimizer');
    return tables;
  } catch (error) {
    migrationLogger.error(
      'Failed to get all tables',
      'optimizer',
      error
    );
    throw error;
  }
}

/**
 * Create missing indexes for tables
 */
async function createMissingIndexes(
  pool: Pool,
  tables: string[],
  dryRun: boolean = false
): Promise<OptimizationResult[]> {
  const results: OptimizationResult[] = [];
  
  migrationLogger.info(
    'Analyzing tables for missing indexes',
    'optimizer'
  );
  
  // Common columns that should be indexed
  const commonIndexes: IndexInfo[] = [
    // Common foreign key columns
    ...tables.map(tableName => ({ 
      tableName, 
      columnName: 'id', 
      unique: true 
    })),
    
    // Foreign key columns for each table
    { tableName: 'order_line_items', columnName: 'order_id' },
    { tableName: 'order_modifiers', columnName: 'line_item_id' },
    { tableName: 'order_discounts', columnName: 'order_id' },
    { tableName: 'gift_card_redemptions', columnName: 'gift_card_id' },
    { tableName: 'gift_card_redemptions', columnName: 'payment_id' },
    
    // Square ID columns
    ...tables.map(tableName => ({
      tableName,
      columnName: 'square_id',
      unique: true
    })).filter(({ tableName }) => 
      !['order_line_items', 'order_modifiers', 'order_discounts'].includes(tableName)
    ),
    
    // Gift card GAN
    { tableName: 'gift_cards', columnName: 'gan', unique: true },
    
    // Timestamps
    ...tables.map(tableName => ({
      tableName,
      columnName: 'created_at'
    }))
  ];
  
  // Filter indexes to only include tables that exist
  const validIndexes = await filterValidIndexes(pool, commonIndexes);
  
  // Check existing indexes
  const existingIndexes = await getExistingIndexes(pool);
  
  // Find indexes to create
  const indexesToCreate: IndexInfo[] = [];
  
  for (const indexInfo of validIndexes) {
    const { tableName, columnName } = indexInfo;
    
    // Skip if table not in our list
    if (!tables.includes(tableName)) {
      continue;
    }
    
    // Check if this column is already indexed
    const isIndexed = existingIndexes.some(idx => 
      idx.tableName === tableName && 
      idx.columnName === columnName
    );
    
    if (!isIndexed) {
      indexesToCreate.push(indexInfo);
    }
  }
  
  migrationLogger.info(
    `Found ${indexesToCreate.length} missing indexes`,
    'optimizer',
    { indexes: indexesToCreate.map(idx => `${idx.tableName}.${idx.columnName}`) }
  );
  
  // Create each missing index
  for (const indexInfo of indexesToCreate) {
    const { tableName, columnName, unique = false } = indexInfo;
    
    try {
      const indexName = `idx_${tableName}_${columnName.replace(/\W+/g, '_')}`;
      const uniqueStr = unique ? 'UNIQUE ' : '';
      const sql = `CREATE ${uniqueStr}INDEX ${indexName} ON "${tableName}" ("${columnName}")`;
      
      migrationLogger.info(
        `Creating index on ${tableName}.${columnName}${dryRun ? ' (DRY RUN)' : ''}`,
        'optimizer',
        { sql }
      );
      
      const timer = migrationLogger.startTimer(`createIndex:${tableName}.${columnName}`);
      
      if (!dryRun) {
        await pool.query(sql);
      }
      
      const elapsed = timer.stop('optimizer');
      
      results.push({
        operation: 'create_index',
        tableName,
        success: true,
        details: {
          columnName,
          indexName,
          unique
        },
        elapsedMs: elapsed
      });
      
    } catch (error) {
      migrationLogger.error(
        `Failed to create index on ${tableName}.${columnName}`,
        'optimizer',
        error
      );
      
      results.push({
        operation: 'create_index',
        tableName,
        success: false,
        details: {
          columnName,
          error: error.message
        }
      });
    }
  }
  
  return results;
}

/**
 * Filter invalid index configurations by checking which tables and columns exist
 */
async function filterValidIndexes(
  pool: Pool,
  indexInfos: IndexInfo[]
): Promise<IndexInfo[]> {
  try {
    // Get all tables and columns
    const result = await pool.query(`
      SELECT 
        t.tablename as table_name,
        a.attname as column_name
      FROM 
        pg_catalog.pg_tables t
      JOIN
        pg_catalog.pg_class c ON c.relname = t.tablename
      JOIN
        pg_catalog.pg_attribute a ON a.attrelid = c.oid
      WHERE 
        t.schemaname = 'public'
        AND a.attnum > 0
        AND NOT a.attisdropped
    `);
    
    // Create lookup map for quick checks
    const validColumns = new Map<string, Set<string>>();
    
    for (const row of result.rows) {
      if (!validColumns.has(row.table_name)) {
        validColumns.set(row.table_name, new Set());
      }
      validColumns.get(row.table_name).add(row.column_name);
    }
    
    // Filter indexes to only include valid table.column combinations
    return indexInfos.filter(({ tableName, columnName }) => {
      const columnsForTable = validColumns.get(tableName);
      return columnsForTable && columnsForTable.has(columnName);
    });
    
  } catch (error) {
    migrationLogger.error(
      'Failed to filter valid indexes',
      'optimizer',
      error
    );
    throw error;
  }
}

/**
 * Get existing indexes in the database
 */
async function getExistingIndexes(pool: Pool): Promise<IndexInfo[]> {
  try {
    const result = await pool.query(`
      SELECT
        t.relname as table_name,
        i.relname as index_name,
        a.attname as column_name,
        ix.indisunique as is_unique
      FROM
        pg_catalog.pg_class t,
        pg_catalog.pg_class i,
        pg_catalog.pg_index ix,
        pg_catalog.pg_attribute a
      WHERE
        t.oid = ix.indrelid
        AND i.oid = ix.indexrelid
        AND a.attrelid = t.oid
        AND a.attnum = ANY(ix.indkey)
        AND t.relkind = 'r'
        AND t.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'public')
      ORDER BY
        t.relname,
        i.relname
    `);
    
    return result.rows.map(row => ({
      tableName: row.table_name,
      columnName: row.column_name,
      indexName: row.index_name,
      unique: row.is_unique
    }));
    
  } catch (error) {
    migrationLogger.error(
      'Failed to get existing indexes',
      'optimizer',
      error
    );
    throw error;
  }
}

/**
 * Vacuum tables to reclaim space and update statistics
 */
async function vacuumTables(
  pool: Pool,
  tables: string[],
  dryRun: boolean = false
): Promise<OptimizationResult[]> {
  const results: OptimizationResult[] = [];
  
  migrationLogger.info(
    `Running VACUUM ANALYZE on ${tables.length} tables${dryRun ? ' (DRY RUN)' : ''}`,
    'optimizer'
  );
  
  for (const tableName of tables) {
    try {
      const timer = migrationLogger.startTimer(`vacuum:${tableName}`);
      
      if (!dryRun) {
        // Need to use direct connection because VACUUM cannot run in a transaction
        const client = await pool.connect();
        try {
          await client.query(`VACUUM ANALYZE "${tableName}"`);
        } finally {
          client.release();
        }
      }
      
      const elapsed = timer.stop('optimizer');
      
      results.push({
        operation: 'vacuum',
        tableName,
        success: true,
        elapsedMs: elapsed
      });
      
    } catch (error) {
      migrationLogger.error(
        `Failed to vacuum table ${tableName}`,
        'optimizer',
        error
      );
      
      results.push({
        operation: 'vacuum',
        tableName,
        success: false,
        details: {
          error: error.message
        }
      });
    }
  }
  
  return results;
}

/**
 * Update table statistics
 */
async function updateTableStats(
  pool: Pool,
  tables: string[],
  dryRun: boolean = false
): Promise<OptimizationResult[]> {
  const results: OptimizationResult[] = [];
  
  migrationLogger.info(
    `Updating statistics for ${tables.length} tables${dryRun ? ' (DRY RUN)' : ''}`,
    'optimizer'
  );
  
  for (const tableName of tables) {
    try {
      const timer = migrationLogger.startTimer(`analyze:${tableName}`);
      
      if (!dryRun) {
        await pool.query(`ANALYZE "${tableName}"`);
      }
      
      const elapsed = timer.stop('optimizer');
      
      results.push({
        operation: 'analyze',
        tableName,
        success: true,
        elapsedMs: elapsed
      });
      
    } catch (error) {
      migrationLogger.error(
        `Failed to analyze table ${tableName}`,
        'optimizer',
        error
      );
      
      results.push({
        operation: 'analyze',
        tableName,
        success: false,
        details: {
          error: error.message
        }
      });
    }
  }
  
  return results;
}

/**
 * Get table statistics
 */
async function getTableStats(
  pool: Pool,
  tables: string[]
): Promise<TableStatsInfo[]> {
  try {
    // Convert array to SQL string
    const tableList = tables.map(t => `'${t}'`).join(',');
    
    const result = await pool.query(`
      SELECT
        t.tablename as table_name,
        c.reltuples::bigint as row_count,
        pg_total_relation_size(c.oid) as size_bytes,
        pg_size_pretty(pg_total_relation_size(c.oid)) as size_formatted,
        c.reloptions as rel_options,
        s.last_analyze as last_analyzed
      FROM
        pg_catalog.pg_tables t
      JOIN
        pg_catalog.pg_class c ON c.relname = t.tablename
      LEFT JOIN
        pg_catalog.pg_stat_user_tables s ON s.relname = t.tablename
      WHERE
        t.schemaname = 'public'
        AND t.tablename = ANY(ARRAY[${tableList}])
      ORDER BY
        t.tablename
    `);
    
    return result.rows.map(row => ({
      tableName: row.table_name,
      rowCount: parseInt(row.row_count || '0', 10),
      sizeBytes: parseInt(row.size_bytes || '0', 10),
      sizeFormatted: row.size_formatted,
      hasAutovacuum: row.rel_options ? row.rel_options.includes('autovacuum_enabled=true') : false,
      lastAnalyzed: row.last_analyzed ? new Date(row.last_analyzed) : undefined
    }));
    
  } catch (error) {
    migrationLogger.error(
      'Failed to get table statistics',
      'optimizer',
      error
    );
    throw error;
  }
}

/**
 * Compare table statistics before and after optimization
 */
function compareTableStats(
  before: TableStatsInfo[],
  after: TableStatsInfo[]
): Record<string, any> {
  const comparison: Record<string, any> = {
    tables: {},
    summary: {
      totalSizeBefore: 0,
      totalSizeAfter: 0,
      totalRowsBefore: 0,
      totalRowsAfter: 0
    }
  };
  
  // Create maps for quick lookup
  const beforeMap = new Map(before.map(stats => [stats.tableName, stats]));
  const afterMap = new Map(after.map(stats => [stats.tableName, stats]));
  
  // Compare each table
  for (const tableName of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const beforeStats = beforeMap.get(tableName);
    const afterStats = afterMap.get(tableName);
    
    if (beforeStats && afterStats) {
      const sizeDiff = afterStats.sizeBytes - beforeStats.sizeBytes;
      const sizeDiffPercent = (beforeStats.sizeBytes > 0)
        ? (sizeDiff / beforeStats.sizeBytes) * 100
        : 0;
      
      comparison.tables[tableName] = {
        sizeBefore: beforeStats.sizeBytes,
        sizeAfter: afterStats.sizeBytes,
        sizeChange: sizeDiff,
        sizeChangePercent: sizeDiffPercent.toFixed(2) + '%',
        rowsBefore: beforeStats.rowCount,
        rowsAfter: afterStats.rowCount
      };
      
      // Update summary
      comparison.summary.totalSizeBefore += beforeStats.sizeBytes;
      comparison.summary.totalSizeAfter += afterStats.sizeBytes;
      comparison.summary.totalRowsBefore += beforeStats.rowCount;
      comparison.summary.totalRowsAfter += afterStats.rowCount;
    }
  }
  
  // Calculate overall changes
  const totalSizeDiff = comparison.summary.totalSizeAfter - comparison.summary.totalSizeBefore;
  const totalSizeDiffPercent = (comparison.summary.totalSizeBefore > 0)
    ? (totalSizeDiff / comparison.summary.totalSizeBefore) * 100
    : 0;
  
  comparison.summary.totalSizeChange = totalSizeDiff;
  comparison.summary.totalSizeChangePercent = totalSizeDiffPercent.toFixed(2) + '%';
  comparison.summary.totalSizeBeforeFormatted = formatBytes(comparison.summary.totalSizeBefore);
  comparison.summary.totalSizeAfterFormatted = formatBytes(comparison.summary.totalSizeAfter);
  comparison.summary.totalSizeChangeFormatted = formatBytes(totalSizeDiff);
  
  return comparison;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Math.abs(bytes);
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  const sign = bytes < 0 ? '-' : '';
  return `${sign}${size.toFixed(2)} ${units[unitIndex]}`;
}

// Run directly if called as script
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tables = args
    .filter(arg => arg.startsWith('--table='))
    .map(arg => arg.split('=')[1]);
  const skipIndexing = args.includes('--skip-indexing');
  const skipVacuum = args.includes('--skip-vacuum');
  const skipStats = args.includes('--skip-stats');
  
  // Create database connection
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  optimizeDatabase(pool, {
    tables,
    skipIndexing,
    skipVacuum,
    skipStats,
    dryRun
  })
    .then(results => {
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.filter(r => !r.success).length;
      
      console.log(`Optimization completed: ${successCount} successful, ${failureCount} failed operations`);
      
      // Find summary result
      const summary = results.find(r => r.operation === 'optimization_summary');
      
      if (summary && summary.details?.statComparison?.summary) {
        const { summary: statsSum } = summary.details.statComparison;
        console.log('\nSize Changes:');
        console.log(`Before: ${statsSum.totalSizeBeforeFormatted}`);
        console.log(`After:  ${statsSum.totalSizeAfterFormatted}`);
        console.log(`Change: ${statsSum.totalSizeChangeFormatted} (${statsSum.totalSizeChangePercent})`);
      }
      
      process.exit(failureCount > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error('Optimization failed:', error);
      process.exit(1);
    })
    .finally(() => {
      pool.end();
    });
}