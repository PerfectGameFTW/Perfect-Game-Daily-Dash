import { logger } from './logger';

// Allow-list of env-var names we are willing to mention by name in
// startup logs. The list is restricted to non-secret feature flags /
// connection identifiers — values are NEVER logged, only presence
// (and only for the missing-required path do we mention names at all,
// because the operator needs to know what to set in order to boot).
const REQUIRED_ENV: readonly string[] = [
  'DATABASE_URL',
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_LOCATION_ID',
  'SESSION_SECRET',
];

const INTERCARD_ENV: readonly string[] = [
  'INTERCARD_HOST',
  'INTERCARD_MAC_ID',
  'INTERCARD_CORP_ID',
];

export function validateEnv(): void {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    // Fatal startup-error path: we are about to exit, the operator
    // needs the names to fix the deployment. Names from the
    // REQUIRED_ENV allow-list only — never values.
    logger.error('startup.missing_required_env', { missing });
    process.exit(1);
  }

  // Optional Intercard integration: presence flag only, never the
  // names of which specific Intercard vars are set/unset. An operator
  // who needs the detail can check the deployment env directly.
  const hasIntercard = INTERCARD_ENV.every((key) => Boolean(process.env[key]));
  logger.info('startup.optional_integrations', { hasIntercard });
}
