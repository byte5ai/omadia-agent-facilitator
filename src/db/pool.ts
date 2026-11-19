// The database as the engine reaches it, declared structurally.
//
// An archetype plugin has no pool and no connection of its own (kernel #2088,
// plugin-api 1.62.0). The kernel hands it two things on `ctx.sql`: one
// statement, and one transaction. Each runs as the plugin's own database
// role, in the plugin's own schema, on whatever server session a pooler
// picks. So nothing here holds a connection, and nothing may rely on state
// of a session: no `SET`, no `LISTEN`, no session-level advisory lock.
//
// Table names are written unqualified everywhere. The role's `search_path`
// is the plugin's schema; a schema name in a statement would be wrong on the
// next instance.

export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

/** Something that runs a statement: the database itself, or a transaction. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

/**
 * The engine's database. `query` is ONE statement on its own; statements
 * that belong together go into `transaction`, which commits when its callback
 * resolves and rolls back when it throws. The handle a transaction passes is
 * refused once the callback settled.
 */
export interface Db extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** The slice of `ctx.sql` (plugin-api 1.62.0) the engine is built on. */
export interface KernelSql {
  readonly schema?: string;
  query?<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ readonly rows: readonly R[]; readonly rowCount: number }>;
  transaction?<T>(work: (tx: { query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ readonly rows: readonly R[]; readonly rowCount: number }> }) => Promise<T>): Promise<T>;
}

/**
 * The engine's database from the kernel's accessor, or undefined when the
 * kernel gave none: no grant by the operator, or a kernel that predates the
 * accessor's `query` and `transaction`.
 */
export function dbOf(sql: KernelSql | undefined): Db | undefined {
  const { query, transaction } = sql ?? {};
  if (!sql || typeof query !== 'function' || typeof transaction !== 'function') return undefined;
  const answer = <R>(result: { readonly rows: readonly unknown[]; readonly rowCount: number }): QueryResult<R> => ({ rows: [...result.rows] as R[], rowCount: result.rowCount });
  return {
    query: async <R = Record<string, unknown>>(text: string, params?: readonly unknown[]) => answer<R>(await query.call(sql, text, params)),
    transaction: <T>(work: (tx: Queryable) => Promise<T>) =>
      transaction.call(sql, (tx) => work({ query: async <R = Record<string, unknown>>(text: string, params?: readonly unknown[]) => answer<R>(await tx.query(text, params)) })) as Promise<T>,
  };
}
