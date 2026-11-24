import { describe, expect, it } from 'vitest';
import type { MainDB } from '../db/schema.js';
import { recordingKysely } from '../test/fakes/recording-dialect.js';
import { fts5Query, KeywordIndex, queryTerms, tsQuery } from './keyword-index.js';

describe('keyword query sanitizer', () => {
  it('quotes terms, ORs them and prefixes the last one', () => {
    expect(fts5Query('Create "issue" in repo*')).toBe('"create" OR "issue" OR "in" OR "repo"*');
    expect(fts5Query('  -- ;; ')).toBeNull();
    expect(tsQuery('create issue')).toBe('create | issue:*');
    expect(queryTerms('a '.repeat(50))).toHaveLength(20);
    expect(fts5Query('NEAR(x y) OR AND')).toBe('"near" OR "x" OR "y" OR "or" OR "and"*');
  });
  it('restricts Postgres ranking to the allowed ids', async () => {
    const { db, driver } = recordingKysely<MainDB>('postgres');
    await new KeywordIndex(db, 'postgres').search('create issue', ['01900000-0000-7000-8000-000000000001']);
    expect(driver.queries[0]!.sql).toMatch(/ts_rank_cd\(t\.search_tsv, to_tsquery\('simple', \$1\)\)[\s\S]*t\.id = any\(\$2::uuid\[\]\)/);
    expect(await new KeywordIndex(db, 'postgres').search('x', [])).toEqual([]);
  });
});
