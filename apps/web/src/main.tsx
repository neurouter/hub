import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { Providers } from '@/app/providers';
import { createQueryClient } from '@/app/query-client';
import { createAppRouter } from '@/app/router';
import { toast } from '@/components/ui/toast';
import { getDisplayPrefs } from '@/lib/display-prefs';
import './styles/globals.css';

async function enableMocks(): Promise<void> {
  if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_MSW === 'true') {
    const { startMockWorker } = await import('@/mocks/browser');
    await startMockWorker();
  }
}

getDisplayPrefs(); // applies the stored table density

const queryClient = createQueryClient({
  onUnauthorized: () => {
    const returnTo = window.location.pathname + window.location.search;
    void router.navigate({ to: '/auth/login', search: { returnTo, error: 'session_expired' } });
  },
  onMutationForbidden: (err) => toast.add({ title: "You don't have permission to do that", description: err.detail ?? err.title, type: 'error' }),
});
const router = createAppRouter({ queryClient });

void enableMocks().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Providers queryClient={queryClient}>
        <RouterProvider router={router} />
      </Providers>
    </StrictMode>,
  );
});
