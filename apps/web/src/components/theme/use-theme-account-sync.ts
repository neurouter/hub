import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Me } from '@neurouter/shared';
import { meQueryOptions } from '@/features/auth/queries';
import { apiFetch } from '@/lib/api-client';
import { useTheme } from './theme-provider';

/**
 * Keeps the theme in the account (PATCH /api/me/preferences) so it follows the user across
 * devices. localStorage stays the source for the first paint (theme-init.js); on sign-in the
 * account's theme, when set, is adopted once; later changes are saved back. Failures are silent:
 * the device keeps its local choice.
 */
export function useThemeAccountSync(me: Pick<Me, 'preferences'>): void {
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const account = me.preferences?.theme;
  const adopted = useRef(false);
  const last = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!adopted.current) {
      // first run: adopt the account's theme (if any) instead of saving the local one
      adopted.current = true;
      last.current = account ?? theme;
      if (account && account !== theme) setTheme(account);
      return;
    }
    if (theme === last.current) return;
    last.current = theme;
    apiFetch(api.me.updatePreferences, { body: { theme } })
      .then((r) => qc.setQueryData(meQueryOptions().queryKey, (m) => (m ? { ...m, preferences: r.preferences } : m)))
      .catch(() => {});
    // `account` is read once on the first run; later changes come from this device
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, qc, setTheme]);
}
