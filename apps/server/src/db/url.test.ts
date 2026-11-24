import { describe, expect, it } from 'vitest';
import { dialectOf, parseDatabaseUrl, redactDatabaseUrl } from './url.js';

describe('database urls', () => {
  it('parses sqlite paths', () => {
    expect(parseDatabaseUrl('sqlite::memory:')).toEqual({ dialect: 'sqlite', filename: ':memory:' });
    expect(parseDatabaseUrl('sqlite:./data/x.db', '/base')).toEqual({ dialect: 'sqlite', filename: '/base/data/x.db' });
    expect(parseDatabaseUrl('sqlite:/abs/x.db')).toEqual({ dialect: 'sqlite', filename: '/abs/x.db' });
    expect(parseDatabaseUrl('sqlite:///abs/x.db')).toEqual({ dialect: 'sqlite', filename: '/abs/x.db' });
    expect(() => parseDatabaseUrl('sqlite:')).toThrow();
  });
  it('parses postgres urls and rejects others', () => {
    expect(parseDatabaseUrl('postgres://u:p@h:5432/db')).toEqual({ dialect: 'postgres', connectionString: 'postgres://u:p@h:5432/db' });
    expect(dialectOf('postgresql://h/db')).toBe('postgres');
    expect(() => dialectOf('mysql://h/db')).toThrow();
  });
  it('redacts passwords', () => {
    expect(redactDatabaseUrl('postgres://neurouter:s3cret@db:5432/n')).toBe('postgres://neurouter:***@db:5432/n');
    expect(redactDatabaseUrl('sqlite:./x.db')).toBe('sqlite:./x.db');
  });
});
