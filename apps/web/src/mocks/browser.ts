import { setupWorker } from 'msw/browser';
import { demoHandlers, handlers } from './handlers';

/**
 * Mock mode: the UI runs against contract fixtures, no backend.
 * - dev: VITE_ENABLE_MSW=true
 * - the static demo site (`npm run build:demo`, VITE_DEMO=true): read-only
 */
export async function startMockWorker({ readOnly = false }: { readOnly?: boolean } = {}): Promise<void> {
  await setupWorker(...(readOnly ? demoHandlers() : handlers)).start({
    onUnhandledFrame: 'bypass',
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    quiet: readOnly,
  });
}
