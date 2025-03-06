/**
 * Migration Logger
 * 
 * This module provides detailed logging functionality for database migrations
 * and data transformations.
 */
import * as fs from 'fs';
import * as path from 'path';

// Log level enum
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

// Log entry interface
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  component: string;
  details?: any;
}

/**
 * Migration Logger class
 * 
 * Provides methods for logging migration operations with different severity levels
 * and persisting logs to files.
 */
export class MigrationLogger {
  private logEntries: LogEntry[] = [];
  private logFile?: string;
  private minLevel: LogLevel;
  private logToConsole: boolean;
  
  /**
   * Create a new migration logger
   * 
   * @param options Logger configuration options
   */
  constructor(options: {
    logFile?: string;
    minLevel?: LogLevel;
    logToConsole?: boolean;
  } = {}) {
    const {
      logFile,
      minLevel = LogLevel.INFO,
      logToConsole = true
    } = options;
    
    this.logFile = logFile;
    this.minLevel = minLevel;
    this.logToConsole = logToConsole;
    
    // Create log directory if needed
    if (logFile) {
      const logDir = path.dirname(logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      // Initialize log file with header
      const timestamp = new Date().toISOString();
      fs.writeFileSync(
        logFile,
        `# Migration Log Started at ${timestamp}\n` +
        `# Level: ${LogLevel[minLevel]}\n\n`,
        'utf8'
      );
    }
  }
  
  /**
   * Log a debug message
   * 
   * @param message Log message
   * @param component Component or module name
   * @param details Additional details (object or error)
   */
  debug(message: string, component: string, details?: any): void {
    this.log(LogLevel.DEBUG, message, component, details);
  }
  
  /**
   * Log an info message
   * 
   * @param message Log message
   * @param component Component or module name
   * @param details Additional details (object or error)
   */
  info(message: string, component: string, details?: any): void {
    this.log(LogLevel.INFO, message, component, details);
  }
  
  /**
   * Log a warning message
   * 
   * @param message Log message
   * @param component Component or module name
   * @param details Additional details (object or error)
   */
  warn(message: string, component: string, details?: any): void {
    this.log(LogLevel.WARN, message, component, details);
  }
  
  /**
   * Log an error message
   * 
   * @param message Log message
   * @param component Component or module name
   * @param details Additional details (object or error)
   */
  error(message: string, component: string, details?: any): void {
    this.log(LogLevel.ERROR, message, component, details);
  }
  
  /**
   * Log a message with the specified level
   * 
   * @param level Log level
   * @param message Log message
   * @param component Component or module name
   * @param details Additional details (object or error)
   */
  log(level: LogLevel, message: string, component: string, details?: any): void {
    // Skip if level is below minimum
    if (level < this.minLevel) {
      return;
    }
    
    const timestamp = new Date().toISOString();
    
    // Create log entry
    const entry: LogEntry = {
      timestamp,
      level,
      message,
      component,
      details
    };
    
    // Add to in-memory log
    this.logEntries.push(entry);
    
    // Log to console if enabled
    if (this.logToConsole) {
      const levelStr = LogLevel[level].padEnd(5);
      const componentStr = component.padEnd(15);
      
      let consoleOutput = `[${timestamp}] ${levelStr} [${componentStr}] ${message}`;
      
      // Use appropriate console method based on level
      switch (level) {
        case LogLevel.DEBUG:
          console.debug(consoleOutput);
          if (details) console.debug(details);
          break;
        case LogLevel.INFO:
          console.info(consoleOutput);
          if (details) console.info(details);
          break;
        case LogLevel.WARN:
          console.warn(consoleOutput);
          if (details) console.warn(details);
          break;
        case LogLevel.ERROR:
          console.error(consoleOutput);
          if (details) console.error(details);
          break;
      }
    }
    
    // Write to log file if configured
    if (this.logFile) {
      try {
        const levelStr = LogLevel[level].padEnd(5);
        const componentStr = component.padEnd(15);
        
        let fileOutput = `[${timestamp}] ${levelStr} [${componentStr}] ${message}`;
        
        if (details) {
          if (details instanceof Error) {
            fileOutput += `\n  Error: ${details.message}`;
            if (details.stack) {
              fileOutput += `\n  Stack: ${details.stack.split('\n').join('\n    ')}`;
            }
          } else {
            try {
              fileOutput += `\n  Details: ${JSON.stringify(details, null, 2).split('\n').join('\n    ')}`;
            } catch (e) {
              fileOutput += `\n  Details: [Cannot stringify details]`;
            }
          }
        }
        
        fileOutput += '\n';
        
        fs.appendFileSync(this.logFile, fileOutput, 'utf8');
      } catch (error) {
        // If writing to file fails, log to console and disable file logging
        console.error(`Failed to write to log file ${this.logFile}:`, error);
        this.logFile = undefined;
      }
    }
  }
  
  /**
   * Get all log entries
   * 
   * @returns Array of log entries
   */
  getEntries(): LogEntry[] {
    return [...this.logEntries];
  }
  
  /**
   * Save all log entries to a JSON file
   * 
   * @param filePath Path to save log entries
   */
  saveToJson(filePath: string): boolean {
    try {
      const logDir = path.dirname(filePath);
      
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          metadata: {
            timestamp: new Date().toISOString(),
            entryCount: this.logEntries.length
          },
          logs: this.logEntries
        }, null, 2),
        'utf8'
      );
      
      return true;
    } catch (error) {
      console.error(`Failed to save logs to ${filePath}:`, error);
      return false;
    }
  }
  
  /**
   * Clear all log entries
   */
  clear(): void {
    this.logEntries = [];
  }
  
  /**
   * Log a section header for better organization
   * 
   * @param title Section title
   * @param component Component or module name
   */
  section(title: string, component: string): void {
    const separator = '='.repeat(title.length + 4);
    this.info(`\n${separator}`, component);
    this.info(`  ${title}  `, component);
    this.info(`${separator}\n`, component);
  }
  
  /**
   * Start timing an operation for performance tracking
   * 
   * @param operation Operation name
   * @returns Timing object with stop method
   */
  startTimer(operation: string): { stop: (component: string) => number } {
    const startTime = Date.now();
    
    return {
      stop: (component: string): number => {
        const endTime = Date.now();
        const elapsed = endTime - startTime;
        
        this.info(
          `Operation "${operation}" completed in ${elapsed}ms`,
          component,
          { startTime, endTime, elapsed }
        );
        
        return elapsed;
      }
    };
  }
  
  /**
   * Generate a summary report from log entries
   * 
   * @returns Summary report string
   */
  generateSummary(): string {
    const errors = this.logEntries.filter(entry => entry.level === LogLevel.ERROR);
    const warnings = this.logEntries.filter(entry => entry.level === LogLevel.WARN);
    
    // Count operations by component
    const componentCounts: Record<string, number> = {};
    
    for (const entry of this.logEntries) {
      componentCounts[entry.component] = (componentCounts[entry.component] || 0) + 1;
    }
    
    let summary = `
========================================
MIGRATION LOG SUMMARY
========================================

Total Entries: ${this.logEntries.length}
Errors: ${errors.length}
Warnings: ${warnings.length}

Components:
${Object.entries(componentCounts)
  .sort((a, b) => b[1] - a[1])
  .map(([component, count]) => `  - ${component}: ${count} entries`)
  .join('\n')
}
`;

    if (errors.length > 0) {
      summary += `
ERROR SUMMARY:
${errors.map(error => `  - [${error.component}] ${error.message}`).join('\n')}
`;
    }

    if (warnings.length > 0) {
      summary += `
WARNING SUMMARY:
${warnings.map(warning => `  - [${warning.component}] ${warning.message}`).join('\n')}
`;
    }

    return summary;
  }
}

// Create a default instance for easy import
export const migrationLogger = new MigrationLogger({
  logFile: path.join('logs', `migration-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
});