import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { db, sql, pool } from "./db"; // Import db, sql and pool
import { authService } from "./services/authService";
import { startScheduler } from "./services/schedulerService";

// Prevent unhandled async errors from crashing the process.
// Node.js 15+ exits by default on unhandledRejection — this keeps the server alive.
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection (caught by global handler):', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (caught by global handler):', err);
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Configure session middleware
const PgSession = connectPgSimple(session);
app.use(session({
  store: new PgSession({
    pool: pool as any, // Type casting to avoid compatibility issues
    tableName: 'sessions', // Default table name
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'perfect-game-dashboard-secret',
  resave: true, // Changed to true to ensure session is saved on every request
  saveUninitialized: true, // Changed to true to ensure new sessions are saved
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: false, // Changed to false to work in development
    sameSite: 'lax', // Helps with CSRF protection but allows normal navigation
    httpOnly: true // Prevents JavaScript access to cookie
  },
  name: 'pg.sid' // Added custom name to avoid conflicts
}));

// Add startup timestamp and environment check
const startTime = new Date().toISOString();
log(`Starting application at ${startTime}`);
log('Environment check:');
console.log({
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL ? '[PRESENT]' : '[MISSING]',
  PORT: process.env.PORT || 5000
});

// Add request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

async function exitWithError(error: unknown) {
  log(`Fatal error during startup: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
  log(`Error stack: ${error instanceof Error ? error.stack : 'No stack trace available'}`, 'error');

  // Brief delay to ensure logs are flushed
  await new Promise(resolve => setTimeout(resolve, 1000));
  process.exit(1);
}

(async () => {
  try {
    // Verify database connection with detailed logging
    log('Verifying database connection...');
    try {
      await db.execute(sql`SELECT version()`);
      log('✓ Database connection verified');
      
      // Create initial admin user if none exists
      try {
        const adminUser = await authService.createInitialAdmin('admin', 'perfgame2025');
        if (adminUser) {
          log('✓ Created initial admin user: admin');
        } else {
          log('ℹ Users already exist, skipping initial admin creation');
        }
      } catch (adminError) {
        log(`⚠ Warning: Could not create initial admin: ${adminError instanceof Error ? adminError.message : 'Unknown error'}`);
        // Don't throw error, just log warning as this isn't critical
      }
    } catch (dbError) {
      log('✗ Database connection failed', 'error');
      throw dbError;
    }

    log('Registering routes...');
    const server = await registerRoutes(app);
    log('✓ Routes registered successfully');

    // Error handling middleware
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      log(`Error handler caught: ${err.message}`, 'error');
      if (!res.headersSent) {
        res.status(status).json({ message });
      }
    });

    // Vite setup with enhanced logging
    if (app.get("env") === "development") {
      log('Setting up Vite development server...');
      await setupVite(app, server);
      log('✓ Vite development server ready');
    } else {
      log('Setting up static file serving...');
      serveStatic(app);
      log('✓ Static file serving ready');
    }

    // Server startup with simplified configuration
    const port = 5000;
    server.listen({
      port,
      host: "0.0.0.0"
    }, () => {
      log(`✓ Server ready and listening on port ${port}`);
      // Start nightly sync scheduler (3 AM Eastern Time every day)
      startScheduler();
    });

  } catch (error) {
    await exitWithError(error);
  }
})();