import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/** Dev-only mock mode (VITE_ENABLE_MSW=true): the UI runs against contract fixtures, no backend. */
export async function startMockWorker(): Promise<void> {
  await setupWorker(...handlers).start({ onUnhandledFrame: 'bypass' });
}
