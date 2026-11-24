import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { ArchiveError, type ArchiveStore } from './store.js';

/** Local directory (dev default). Writes atomically (temp file + rename). */
export class LocalFsArchive implements ArchiveStore {
  readonly kind = 'local-fs' as const;
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  get location(): string {
    return `file://${this.root}`;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = resolve(this.root, key);
    if (!target.startsWith(this.root + sep)) throw new ArchiveError(`Archive key escapes the archive root: ${key}`);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, body, { mode: 0o640 });
    await rename(tmp, target);
  }
}
