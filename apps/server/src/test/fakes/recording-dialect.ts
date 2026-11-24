import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';

/** Captures compiled SQL without a database, so Postgres paths are unit-testable with no server. */
export class RecordingDriver implements Driver {
  readonly queries: CompiledQuery[] = [];
  constructor(private readonly respond: (q: CompiledQuery) => QueryResult<unknown> = () => ({ rows: [] })) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    const queries = this.queries;
    const respond = this.respond;
    return {
      async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
        queries.push(q);
        return respond(q) as QueryResult<R>;
      },
      // eslint-disable-next-line require-yield
      async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
        throw new Error('streaming not supported by RecordingDriver');
      },
    };
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
  /** All captured SQL, lower-cased and whitespace-normalized. */
  sql(): string[] {
    return this.queries.map((q) => q.sql.replace(/\s+/g, ' ').toLowerCase());
  }
}

export function recordingKysely<DB = unknown>(dialect: 'postgres' | 'sqlite', driver = new RecordingDriver()) {
  const d: Dialect =
    dialect === 'postgres'
      ? {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => driver,
          createIntrospector: (db) => new PostgresIntrospector(db),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        }
      : {
          createAdapter: () => new SqliteAdapter(),
          createDriver: () => driver,
          createIntrospector: (db) => new SqliteIntrospector(db),
          createQueryCompiler: () => new SqliteQueryCompiler(),
        };
  return { db: new Kysely<DB>({ dialect: d }), driver };
}
