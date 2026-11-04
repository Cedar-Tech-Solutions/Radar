// D1 reads issued together, sent together.
//
// A Worker on the free plan may make fifty subrequests in one invocation, and every D1 statement
// is one. The staff workspace read sixty-odd on a load, each `prepare().all()` its own round trip,
// and the limit is a hard one: past it the invocation fails. A `batch()` is one subrequest however
// many statements it carries, so the reads a handler issues at the same moment - the ones it was
// already running side by side under Promise.all - go out as one.
//
// The collection is by moment, not by call site: a statement run here joins the batch of every
// other statement run before the current task yields (the microtask the first one schedules). A
// Promise.all over a list of them is exactly that, and so is a helper that starts its own reads
// inside such a list, since an async function runs up to its first await before anything else
// does. A read issued after an await starts the next batch. Nothing about the queries themselves
// changes: the same SQL, the same bindings, the same rows.
//
// Reads only. A statement in a batch runs in the batch's transaction, in order, and one failing
// fails them all - the right thing for a page of reads that is useless with any of them missing,
// and not something to hand a write path, whose statements are ordered on purpose.
type Row = Record<string, unknown>;

export interface CollectedStatement {
  bind(...values: unknown[]): CollectedStatement;
  all<T = Row>(): Promise<D1Result<T>>;
  first<T = Row>(): Promise<T | null>;
  first<T = unknown>(column: string): Promise<T | null>;
}

export interface CollectedReads {
  prepare(sql: string): CollectedStatement;
}

type Pending = { statement: D1PreparedStatement; resolve: (result: D1Result<Row>) => void; reject: (cause: unknown) => void };

export function collectReads(db: D1Database): CollectedReads {
  let pending: Pending[] = [];
  let scheduled = false;
  const flush = async () => {
    scheduled = false;
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    // One statement on its own is sent on its own: the same subrequest, and D1 answers a single
    // statement without the batch's transaction around it.
    if (batch.length === 1) {
      try { batch[0].resolve(await batch[0].statement.all<Row>()); } catch (cause) { batch[0].reject(cause); }
      return;
    }
    try {
      const results = await db.batch<Row>(batch.map((entry) => entry.statement));
      batch.forEach((entry, index) => entry.resolve(results[index]));
    } catch (cause) {
      for (const entry of batch) entry.reject(cause);
    }
  };
  const run = (statement: D1PreparedStatement) => new Promise<D1Result<Row>>((resolve, reject) => {
    pending.push({ statement, resolve, reject });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => { void flush(); });
    }
  });
  const wrap = (statement: D1PreparedStatement): CollectedStatement => ({
    bind: (...values) => wrap(statement.bind(...values)),
    all: <T,>() => run(statement) as Promise<D1Result<T>>,
    first: async <T,>(column?: string) => {
      const { results } = await run(statement);
      const row = results[0];
      if (row === undefined) return null;
      return (column === undefined ? row : (row[column] ?? null)) as T | null;
    },
  });
  return { prepare: (sql) => wrap(db.prepare(sql)) };
}
