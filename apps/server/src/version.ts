import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_PACKAGE_DIR } from './config/load.js';

/** Server version from apps/server/package.json (works from src/ and dist/). */
export const SERVER_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(SERVER_PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();
