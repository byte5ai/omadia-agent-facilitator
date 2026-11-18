// The slice of `pg` the engine uses, declared structurally. The package ships
// unbundled and resolves everything through host-provided peers, so it must
// not import `pg` at runtime; the kernel hands over its pool as a service.

export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface PoolClientLike extends Queryable {
  release(err?: Error | boolean): void;
}

export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
}
