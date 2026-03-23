export function validateEnv(): void {
  const required: string[] = [
    'DATABASE_URL',
    'SQUARE_ACCESS_TOKEN',
    'SQUARE_LOCATION_ID',
    'SESSION_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const intercardVars = ['INTERCARD_HOST', 'INTERCARD_MAC_ID', 'INTERCARD_CORP_ID'];
  const missingIntercard = intercardVars.filter((key) => !process.env[key]);
  if (missingIntercard.length > 0) {
    console.warn(`[validateEnv] Intercard integration disabled — missing: ${missingIntercard.join(', ')}`);
  }
}
