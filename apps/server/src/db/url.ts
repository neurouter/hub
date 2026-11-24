import { isAbsolute, resolve } from 'node:path';

export type Dialect = 'sqlite' | 'postgres';

export type DatabaseTarget =
  | { dialect: 'sqlite'; filename: string }
  | { dialect: 'postgres'; connectionString: string };

export function dialectOf(url: string): Dialect {
  if (url.startsWith('sqlite:')) return 'sqlite';
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgres';
  throw new Error('Database URL must start with sqlite: or postgres://');
}

/**
 * `sqlite:./data/x.db` (relative to `baseDir`, default cwd), `sqlite:/abs/x.db`, `sqlite:///abs/x.db`,
 * `sqlite::memory:`; `postgres://user:pass@host:5432/db`.
 */
export function parseDatabaseUrl(url: string, baseDir = process.cwd()): DatabaseTarget {
  const dialect = dialectOf(url);
  if (dialect === 'postgres') return { dialect, connectionString: url };
  let path = url.slice('sqlite:'.length);
  if (path.startsWith('//')) path = path.slice(2);
  if (path === '' ) throw new Error('sqlite: URL needs a file path or :memory:');
  if (path === ':memory:') return { dialect, filename: ':memory:' };
  return { dialect, filename: isAbsolute(path) ? path : resolve(baseDir, path) };
}

/** URL with the password masked, for logs. */
export function redactDatabaseUrl(url: string): string {
  return url.replace(/(postgres(?:ql)?:\/\/[^:/@]+:)[^@]*@/, '$1***@');
}
