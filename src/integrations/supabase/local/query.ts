import { getLocalAuthUid } from './auth';
import { loadDb, mutateDb, nowIso, uid, type LocalDb, type LocalTableName } from './store';

type Filter =
  | { type: 'eq'; col: string; value: unknown }
  | { type: 'in'; col: string; values: unknown[] }
  | { type: 'is'; col: string; value: null | boolean };

type Order = { col: string; ascending: boolean };

type PostgrestError = { message: string; details?: string; hint?: string; code?: string };

function err(message: string): PostgrestError {
  return { message, code: 'PGRST', details: '', hint: '' };
}

function ok<T>(data: T) {
  return { data, error: null as PostgrestError | null, count: null, status: 200, statusText: 'OK' };
}

function fail(message: string) {
  return { data: null, error: err(message), count: null, status: 400, statusText: 'Error' };
}

function getTable(db: LocalDb, table: string): Record<string, unknown>[] {
  const rows = (db as unknown as Record<string, unknown[]>)[table];
  if (!Array.isArray(rows)) return [];
  return rows as Record<string, unknown>[];
}

function applyFilters(rows: Record<string, unknown>[], filters: Filter[]) {
  return rows.filter((row) =>
    filters.every((f) => {
      const v = row[f.col];
      if (f.type === 'eq') return v === f.value;
      if (f.type === 'in') return f.values.includes(v);
      if (f.type === 'is') return v === f.value;
      return true;
    })
  );
}

function applyOrder(rows: Record<string, unknown>[], order?: Order) {
  if (!order) return rows;
  const { col, ascending } = order;
  return [...rows].sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    if (av === bv) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return ascending ? -1 : 1;
    return ascending ? 1 : -1;
  });
}

/** Parse embeds like `team1_player1:players!team1_player1_id(name)` or `players(name)`. */
function resolveEmbeds(db: LocalDb, table: string, row: Record<string, unknown>, select: string) {
  const out: Record<string, unknown> = { ...row };
  const embedRe =
    /(?:^|,)\s*(?:(\w+)\s*:\s*)?(\w+)(?:!(\w+))?\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = embedRe.exec(select))) {
    const alias = m[1] || m[2];
    const foreignTable = m[2];
    const fkHint = m[3];
    const cols = m[4]
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    let fkCol = fkHint;
    if (!fkCol) {
      // match_history → players via player_id
      if (table === 'match_history' && foreignTable === 'players') fkCol = 'player_id';
      else fkCol = `${foreignTable.replace(/s$/, '')}_id`;
    }

    const fkVal = row[fkCol];
    const foreign = getTable(db, foreignTable).find((r) => r.id === fkVal) || null;
    if (!foreign) {
      out[alias] = null;
      continue;
    }
    if (cols.length === 0 || cols[0] === '*') {
      out[alias] = foreign;
    } else {
      const picked: Record<string, unknown> = {};
      cols.forEach((c) => {
        picked[c] = foreign[c];
      });
      out[alias] = picked;
    }
  }

  // Strip raw join noise if select listed only some columns without *
  if (select.includes('*') || select.trim() === '') return out;
  if (!select.includes('(')) {
    const cols = select.split(',').map((c) => c.trim()).filter(Boolean);
    const picked: Record<string, unknown> = {};
    cols.forEach((c) => {
      picked[c] = out[c];
    });
    return picked;
  }
  return out;
}

function projectRows(db: LocalDb, table: string, rows: Record<string, unknown>[], select: string) {
  const cleaned = select.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned === '*') return rows;
  return rows.map((row) => resolveEmbeds(db, table, row, cleaned));
}

class QueryBuilder {
  private table: LocalTableName;
  private filters: Filter[] = [];
  private orderBy?: Order;
  private limitN?: number;
  private selectClause = '*';
  private mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private wantSingle = false;
  private wantMaybeSingle = false;

  constructor(table: LocalTableName) {
    this.table = table;
  }

  select(columns = '*') {
    this.selectClause = columns;
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.mode = 'insert';
    this.payload = values;
    return this;
  }

  update(values: Record<string, unknown>) {
    this.mode = 'update';
    this.payload = values;
    return this;
  }

  upsert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.mode = 'upsert';
    this.payload = values;
    return this;
  }

  delete() {
    this.mode = 'delete';
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push({ type: 'eq', col, value });
    return this;
  }

  in(col: string, values: unknown[]) {
    this.filters.push({ type: 'in', col, values });
    return this;
  }

  is(col: string, value: null | boolean) {
    this.filters.push({ type: 'is', col, value });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, ascending: opts?.ascending ?? true };
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  single() {
    this.wantSingle = true;
    return this;
  }

  maybeSingle() {
    this.wantMaybeSingle = true;
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: ReturnType<typeof ok>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return this.execute().then(onfulfilled as never, onrejected);
  }

  private execute() {
    try {
      if (this.mode === 'select') return Promise.resolve(this.runSelect());
      if (this.mode === 'insert') return Promise.resolve(this.runInsert());
      if (this.mode === 'update') return Promise.resolve(this.runUpdate());
      if (this.mode === 'upsert') return Promise.resolve(this.runUpsert());
      if (this.mode === 'delete') return Promise.resolve(this.runDelete());
      return Promise.resolve(fail('Unsupported query'));
    } catch (e) {
      return Promise.resolve(fail(e instanceof Error ? e.message : String(e)));
    }
  }

  private runSelect() {
    const db = loadDb();
    let rows = applyFilters(getTable(db, this.table), this.filters);
    rows = applyOrder(rows, this.orderBy);
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    const projected = projectRows(db, this.table, rows, this.selectClause);

    if (this.wantSingle) {
      if (projected.length !== 1) return fail('JSON object requested, multiple (or no) rows returned');
      return ok(projected[0]);
    }
    if (this.wantMaybeSingle) {
      if (projected.length > 1) return fail('JSON object requested, multiple rows returned');
      return ok(projected[0] ?? null);
    }
    return ok(projected);
  }

  private runInsert() {
    const rowsIn = Array.isArray(this.payload) ? this.payload : [this.payload!];
    const inserted: Record<string, unknown>[] = [];
    const t = nowIso();
    const userId = getLocalAuthUid();

    mutateDb((db) => {
      const table = getTable(db, this.table);
      for (const row of rowsIn) {
        const next = {
          ...row,
          id: (row.id as string) || uid(),
          created_at: (row.created_at as string) || t,
          updated_at: (row.updated_at as string) || t,
        };
        if (this.table === 'session_templates' && !next.created_by) {
          next.created_by = userId;
        }
        table.push(next);
        inserted.push(next);
      }
    });

    const db = loadDb();
    const projected = projectRows(db, this.table, inserted, this.selectClause);
    if (this.wantSingle) return ok(projected[0] ?? null);
    return ok(projected);
  }

  private runUpdate() {
    const patch = this.payload as Record<string, unknown>;
    const updated: Record<string, unknown>[] = [];
    mutateDb((db) => {
      const table = getTable(db, this.table);
      for (let i = 0; i < table.length; i++) {
        const row = table[i];
        if (!applyFilters([row], this.filters).length) continue;
        table[i] = { ...row, ...patch, updated_at: nowIso() };
        updated.push(table[i]);
      }
    });
    const db = loadDb();
    const projected = projectRows(db, this.table, updated, this.selectClause);
    if (this.wantSingle) return ok(projected[0] ?? null);
    return ok(projected);
  }

  private runUpsert() {
    const rowsIn = Array.isArray(this.payload) ? this.payload : [this.payload!];
    const result: Record<string, unknown>[] = [];
    const t = nowIso();
    mutateDb((db) => {
      const table = getTable(db, this.table);
      for (const row of rowsIn) {
        const id = row.id as string;
        const idx = table.findIndex((r) => r.id === id);
        if (idx >= 0) {
          table[idx] = { ...table[idx], ...row, updated_at: t };
          result.push(table[idx]);
        } else {
          const next = { created_at: t, updated_at: t, ...row, id: id || uid() };
          table.push(next);
          result.push(next);
        }
      }
    });
    const db = loadDb();
    const projected = projectRows(db, this.table, result, this.selectClause);
    if (this.wantSingle) return ok(projected[0] ?? null);
    return ok(projected);
  }

  private runDelete() {
    mutateDb((db) => {
      const table = getTable(db, this.table);
      const keep = table.filter((row) => !applyFilters([row], this.filters).length);
      table.splice(0, table.length, ...keep);
    });
    return ok(null);
  }
}

export function fromTable(table: LocalTableName) {
  return new QueryBuilder(table);
}
