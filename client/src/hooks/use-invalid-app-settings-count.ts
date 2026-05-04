import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';

interface AppSettingsValidationEntry {
  key: string;
  status: 'valid' | 'invalid' | 'missing';
}

interface AppSettingsValidationResponse {
  validatedAt: string;
  entries: AppSettingsValidationEntry[];
}

export const APP_SETTINGS_VALIDATION_QUERY_KEY = [
  '/api/admin/app-settings/validation',
] as const;

/**
 * Polls the registry validation endpoint on a slow interval so the
 * Admin nav button (on the Dashboard) and the Alerts tab trigger
 * inside the Admin page can surface a red dot whenever at least one
 * `app_settings` row is broken (Task #181). The query is only
 * enabled for admins so non-admin users never hit the 401 path.
 *
 * Shares its queryKey with `AppSettingsRegistryStatusCard` so opening
 * the panel reuses the most recent validation result instantly and
 * any manual Refresh in the panel also clears the badge.
 */
export function useInvalidAppSettingsCount() {
  const { user } = useAuth();
  const enabled = user?.role === 'admin';

  const { data } = useQuery<AppSettingsValidationResponse>({
    queryKey: APP_SETTINGS_VALIDATION_QUERY_KEY,
    enabled,
    // 60s is slow enough to be cheap (re-runs zod over every
    // registered key on the server) but fast enough that an admin
    // who's been sitting on another tab notices a fresh break
    // within a minute.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });

  if (!enabled || !data) return 0;
  return data.entries.filter((e) => e.status === 'invalid').length;
}
