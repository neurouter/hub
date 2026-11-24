import { rmSync } from 'node:fs';

/** Removes the temporary SQLite directory created by playwright.config.ts. */
export default function globalTeardown() {
  const dir = process.env.E2E_DATA_DIR;
  if (dir && dir.includes('neurouter-e2e-')) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
