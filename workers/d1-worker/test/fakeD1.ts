/**
 * FakeD1 — an in-memory test double for the Cloudflare D1 binding.
 *
 * This is a LOCAL TEST HARNESS ONLY. It is explicitly NOT a "real" Cloudflare
 * D1 database (see 16F report / STEP16E §16F-11). It implements just enough of
 * the `D1Database` interface to let the `CloudflareGlobalSampleIndex` provider
 * run its real SQL logic against faithful in-memory tables, so we can verify
 * batching, chunking, conflict detection, idempotency, map ordering, and
 * no-audio behavior deterministically without an account or network.
 *
 * It supports the exact statement shapes the provider emits (SELECT joins,
 * INSERT ... ON CONFLICT DO NOTHING / DO UPDATE ... WHERE ... RETURNING, bbox
 * ORDER BY ... LIMIT/OFFSET, MIN() aggregation). It mirrors D1's row semantics
 * including `meta.changes` (rows written/updated) and atomic `batch()`.
 */

type Row = Record<string, unknown>;

/** Row-selection context for the mini-SQL engine: alias -> row. */
interface Ctx {
  aliases: Record<string, Row>;
}

interface Table {
  name: string;
  /** primary key -> row */
  rows: Map<string, Row>;
  /** extra indexes for uniqueness checks */
  uniqueKeys: string[];
}

interface FakeResult<T = Row> {
  success: true;
  meta: Record<string, unknown>;
  results: T[];
}

class FakePreparedStatement {
  private binds: unknown[] = [];
  constructor(
    private readonly sql: string,
    private readonly engine: FakeD1,
  ) {}

  getSql(): string {
    return this.sql;
  }

  getBinds(): unknown[] {
    return this.binds;
  }

  bind(...values: unknown[]): this {
    this.binds.push(...values);
    return this;
  }

  async first<T = Row>(): Promise<T | null> {
    const r = this.engine.execute(this.sql, this.binds);
    return (r.results[0] as T) ?? null;
  }

  async run<T = Row>(): Promise<FakeResult<T>> {
    return this.engine.execute(this.sql, this.binds) as FakeResult<T>;
  }

  async all<T = Row>(): Promise<FakeResult<T>> {
    return this.engine.execute(this.sql, this.binds) as FakeResult<T>;
  }

  raw(): never {
    throw new Error("FakeD1: raw() not implemented");
  }
}

export class FakeD1 {
  private tables = new Map<string, Table>();

  constructor() {
    this.createTable("sample_ref", [
      "content_hash",
      "content_hash_version",
      "sample_id",
    ]);
    this.createTable("content", []);
  }

  private createTable(name: string, uniqueKeys: string[]): Table {
    const table = { name, rows: new Map<string, Row>(), uniqueKeys };
    this.tables.set(name, table);
    return table;
  }

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(sql, this);
  }

  async batch<T = Row>(statements: FakePreparedStatement[]): Promise<FakeResult<T>[]> {
    // Atomic-ish: snapshot tables, run all synchronously; on failure restore.
    const snapshot = this.snapshot();
    try {
      const out: FakeResult<T>[] = [];
      for (const stmt of statements) {
        out.push(this.execute(stmt.getSql(), stmt.getBinds()) as FakeResult<T>);
      }
      return out;
    } catch (err) {
      this.restore(snapshot);
      throw err;
    }
  }

  private snapshot(): Map<string, Table> {
    const snap = new Map<string, Table>();
    for (const [k, v] of this.tables) {
      snap.set(k, { name: v.name, rows: new Map(v.rows), uniqueKeys: [...v.uniqueKeys] });
    }
    return snap;
  }

  private restore(snap: Map<string, Table>): void {
    this.tables = snap;
  }

  execute(sql: string, binds: unknown[]): FakeResult {
    const s = sql.trim();
    if (s.startsWith("SELECT")) return this.executeSelect(s, binds);
    if (s.startsWith("INSERT")) return this.executeInsert(s, binds);
    throw new Error(`FakeD1: unsupported statement: ${s.slice(0, 60)}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SELECT
  // ───────────────────────────────────────────────────────────────────────────

  private executeSelect(sql: string, binds: unknown[]): FakeResult {
    const effectiveBinds = [...binds];
    let order: Array<[string, "asc" | "desc"]> = [];

    const selMatch = /^SELECT\s+(.+?)\s+FROM\s+(.+)$/is.exec(sql);
    if (!selMatch) throw new Error("FakeD1: bad SELECT");
    const selectPart = selMatch[1];
    const rest = selMatch[2];

    // FROM ... [JOIN ... ON ...] [WHERE ...] [ORDER BY ...] [LIMIT ?] [OFFSET ?]
    const fromParts = parseFrom(rest.trim());
    const table1 = fromParts.table1;
    const alias1 = fromParts.alias1;
    const joinClause = fromParts.joinClause; // "sample_alias ON cond" or null
    const whereSql = fromParts.whereSql ?? "";
    const orderSql = fromParts.orderSql;
    const limitMatch = fromParts.limit;
    const offsetMatch = fromParts.offset;

    let joinAlias: string | null = null;
    let joinTable: string | null = null;
    let joinOn = "";
    if (joinClause) {
      const jm = /^([a-z_]+)\s+([a-z_])\s+ON\s+(.+)$/is.exec(joinClause.trim());
      if (!jm) throw new Error(`FakeD1: unparsable JOIN: ${joinClause}`);
      joinTable = jm[1];
      joinAlias = jm[2];
      joinOn = jm[3];
    }

    if (orderSql) {
      order = orderSql.split(",").map((o) => {
        const p = o.trim().split(/\s+/);
        return [p[0], (p[1]?.toLowerCase() as "asc" | "desc") ?? "asc"] as [
          string,
          "asc" | "desc",
        ];
      });
    }

    // Substitute `?` placeholders with bound JSON literals, in SQL order:
    // JOIN/WHERE params come first, then LIMIT, then OFFSET.
    const resolve = (expr: string): string =>
      expr.replace(/\?/g, () => JSON.stringify(effectiveBinds.shift()));

    const t1 = this.getTable(table1);
    const ctxs: Ctx[] = [];

    if (joinClause) {
      const tj = this.getTable(joinTable as string);
      const onCond = resolve(joinOn);
      for (const left of t1.rows.values()) {
        for (const right of tj.rows.values()) {
          const ctx: Ctx = {
            aliases: { [alias1]: left, [joinAlias as string]: right },
          };
          if (this.evalWhere(onCond, ctx)) ctxs.push(ctx);
        }
      }
    } else {
      for (const row of t1.rows.values()) {
        ctxs.push({ aliases: { [alias1]: row } });
      }
    }

    if (whereSql) {
      const cond = resolve(whereSql);
      const filtered: Ctx[] = [];
      for (const ctx of ctxs) if (this.evalWhere(cond, ctx)) filtered.push(ctx);
      ctxs.length = 0;
      ctxs.push(...filtered);
    }

    // ORDER BY.
    if (order.length) {
      ctxs.sort((a, b) => {
        for (const [col, dir] of order) {
          const av = this.resolveCol(col, a);
          const bv = this.resolveCol(col, b);
          if (av === bv) continue;
          const cmp = (av ?? 0) < (bv ?? 0) ? -1 : 1;
          return dir === "asc" ? cmp : -cmp;
        }
        return 0;
      });
    }

    // Aggregation: MIN(ref) AS alias.
    const agg = /MIN\(\s*([a-z_.]+)\s*\)\s*AS\s+(\w+)/i.exec(selectPart);
    if (agg) {
      const as = agg[2];
      let min: unknown = null;
      for (const ctx of ctxs) {
        const v = this.resolveCol(agg[1], ctx) as unknown;
        if (v !== null && v !== undefined && (min === null || (v as number) < (min as number)))
          min = v;
      }
      const resultRow: Row = { [as]: min === null ? null : (min as never) };
      return { success: true, meta: {}, results: [resultRow] };
    }

    // Project requested columns (respecting AS aliases).
    const cols = this.parseColumns(selectPart);
    const projected = ctxs.map((ctx) => {
      const out: Row = {};
      for (const c of cols) out[c.name] = this.resolveCol(c.ref, ctx);
      return out;
    });

    // LIMIT/OFFSET.
    let offsetVal = 0;
    let limitVal: number | null = null;
    if (limitMatch) limitVal = this.evalScalarOrBind(resolve(limitMatch));
    if (offsetMatch) offsetVal = this.evalScalarOrBind(resolve(offsetMatch));

    let outRows = projected;
    if (offsetVal > 0) outRows = outRows.slice(offsetVal);
    if (limitVal !== null) outRows = outRows.slice(0, limitVal);

    return { success: true, meta: {}, results: outRows };
  }

  /** Resolve an output column in a context by its qualified or bare ref. */
  private resolveCol(ref: string, ctx: Ctx): unknown {
    const m = /^([a-z])\.([a-z0-9_]+)$/i.exec(ref.trim());
    if (m) return ctx.aliases[m[1]]?.[m[2]];
    // Prefer a value present in any known alias row.
    for (const row of Object.values(ctx.aliases)) {
      if (ref.trim() in row) return row[ref.trim()];
    }
    return undefined;
  }

  private evalScalarOrBind(expr: string): number {
    return Number(expr.replace(/"/g, "").trim());
  }

  private parseColumns(selectPart: string): { name: string; ref: string }[] {
    const cols: { name: string; ref: string }[] = [];
    for (const raw of selectPart.split(",")) {
      const tok = raw.trim();
      if (!tok) continue;
      const m = /^(?:[a-z]\.)?([a-z0-9_]+)(?:\s+AS\s+([a-z0-9_]+))?$/i.exec(tok);
      if (!m) continue; // aggregate handled separately
      // The returned column NAME is the bare column (or the AS alias), as real
      // SQLite/D1 does — `SELECT c.content_hash` yields a column named
      // `content_hash`, not `c.content_hash`.
      cols.push({ name: m[2] ?? m[1], ref: tok.split(/\s+AS\s+/i)[0] });
    }
    return cols;
  }

  /**
   * Evaluate a simplified boolean expression against a row context. Supports
   * `=`, `<>`, `>=`, `<=`, `IN (...)` and `AND`. `alias.col` resolves per table;
   * a bare column resolves to whatever alias row carries it.
   */
  private evalWhere(cond: string, ctx: Ctx): boolean {
    const c = cond.trim();
    if (c === "") return true;
    const andParts = splitTopLevel(c);
    return andParts.every((part) => this.evalAtom(part.trim(), ctx));
  }

  private evalAtom(atom: string, ctx: Ctx): boolean {
    const inMatch = /^([a-z_.]+)\s+IN\s*\(([^)]*)\)$/i.exec(atom);
    if (inMatch) {
      const col = inMatch[1];
      const vals = inMatch[2]
        .split(",")
        .map((v) => v.trim().replace(/^["']/, "").replace(/["']$/, ""));
      const actual = String(this.resolveCol(col, ctx));
      return vals.includes(actual);
    }
    const m = /^([a-z0-9_.]+)\s*(=|<>|>=|<=)\s*(.+)$/i.exec(atom);
    if (!m) throw new Error(`FakeD1: unparsable condition: ${atom}`);
    const col = m[1];
    const op = m[2];
    const raw = m[3].trim();
    // RHS may be another column reference (e.g. join condition) or a literal.
    let rhs: unknown;
    const colRef = /^[a-z]+\.[a-z0-9_]+$/.test(raw) || /^[a-z_][a-z0-9_]*$/.test(raw);
    if (colRef) {
      rhs = this.resolveCol(raw, ctx);
    } else {
      const lit = raw.replace(/^["']/, "").replace(/["']$/, "");
      rhs = /^-?\d+(\.\d+)?$/.test(lit) ? Number(lit) : lit;
    }
    const lhs = this.resolveCol(col, ctx);
    if (op === "=") return lhs === rhs;
    if (op === "<>") return lhs !== rhs;
    const l = Number(lhs);
    const r = Number(rhs);
    if (op === ">=") return l >= r;
    if (op === "<=") return l <= r;
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INSERT
  // ───────────────────────────────────────────────────────────────────────────

  private executeInsert(sql: string, binds: unknown[]): FakeResult {
    const tableMatch = /^INSERT\s+INTO\s+([a-z_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(
      sql,
    );
    if (!tableMatch) throw new Error(`FakeD1: bad INSERT: ${sql.slice(0, 50)}`);
    const tableName = tableMatch[1];
    const cols = tableMatch[2].split(",").map((c) => c.trim());
    const placeholders = tableMatch[3].split(",").map((c) => c.trim());

    const row: Row = {};
    placeholders.forEach((p, i) => {
      if (p === "?") row[cols[i]] = binds[i];
      else row[cols[i]] = Number(p);
    });
    // Insert binds consumed up to number of placeholders.
    binds.splice(0, placeholders.length);

    const table = this.getTable(tableName);

    // Unique constraints: content(sample_id) for sample_ref; (content_hash,version) for content.
    const conflicts = this.findConflictKeys(table, row);

    const isSampleRef = tableName === "sample_ref";
    const sampleId = String(row.sample_id);
    const existingContentRow = isSampleRef ? table.rows.get(sampleId) : undefined;

    // ON CONFLICT(content_hash, content_hash_version) DO NOTHING  (content)
    if (/ON\s+CONFLICT\(content_hash,\s*content_hash_version\)\s+DO\s+NOTHING/i.test(sql)) {
      if (conflicts.length > 0) {
        // Already present → no-op; note: the NEW submitted values are discarded
        // (first-valid-wins, no last-write-wins).
        return { success: true, meta: { changes: 0 }, results: [] };
      }
      this.upsertRow(table, row);
      return { success: true, meta: { changes: 1 }, results: [] };
    }

    // STEP41 backfill: ON CONFLICT(content_hash, content_hash_version)
    //   DO UPDATE SET sound_character_v2 = COALESCE(content.sound_character_v2,
    //                                               excluded.sound_character_v2)
    // Inserts when absent; otherwise fills sound_character_v2 ONLY when the
    // stored row has none (never clobbers an existing block, first-valid-wins
    // preserved for every other column). (content)
    if (this.isV2KnowledgeBackfill(sql)) {
      const key = `${String(row.content_hash)}::${String(row.content_hash_version)}`;
      const existing = table.rows.get(key) as Row | undefined;
      if (!existing) {
        this.upsertRow(table, row);
        return { success: true, meta: { changes: 1 }, results: [] };
      }
      if (existing.sound_character_v2 == null && row.sound_character_v2 != null) {
        existing.sound_character_v2 = row.sound_character_v2;
        return { success: true, meta: { changes: 1 }, results: [] };
      }
      return { success: true, meta: { changes: 0 }, results: [] };
    }

    // ON CONFLICT(sample_id) DO UPDATE ... WHERE sample_ref.content_hash = excluded... (sample_ref)
    if (/ON\s+CONFLICT\(sample_id\)\s+DO\s+UPDATE/i.test(sql)) {
      if (existingContentRow) {
        const sameContent =
          String(existingContentRow.content_hash) === String(row.content_hash) &&
          String(existingContentRow.content_hash_version) ===
            String(row.content_hash_version);
        if (sameContent) {
          // Identical re-publish → no change (already-known).
          return { success: true, meta: { changes: 0 }, results: [] };
        }
        // Different content → WHERE guard fails → no update (conflict). The
        // sample's row is left pointing at its ORIGINAL content (no overwrite).
        return { success: true, meta: { changes: 0 }, results: [] };
      }
      // New sample binding → insert.
      this.upsertRow(table, row);
      return { success: true, meta: { changes: 1 }, results: [] };
    }

    throw new Error(`FakeD1: unsupported INSERT conflict clause`);
  }

  private findConflictKeys(table: Table, row: Row): string[] {
    if (table.name === "content") {
      const key = `${String(row.content_hash)}::${String(row.content_hash_version)}`;
      return table.rows.has(key) ? [key] : [];
    }
    return [];
  }

  /** Match the STEP41 V2-knowledge backfill upsert clause exactly as the
   *  provider emits it (content table). */
  private isV2KnowledgeBackfill(sql: string): boolean {
    return /ON\s+CONFLICT\(content_hash,\s*content_hash_version\)\s+DO\s+UPDATE SET\s+sound_character_v2\s*=\s*COALESCE\(content\.sound_character_v2,[\s\S]*excluded\.sound_character_v2\)/i.test(
      sql,
    );
  }

  private upsertRow(table: Table, row: Row): void {
    let key: string;
    if (table.name === "sample_ref") key = String(row.sample_id);
    else key = `${String(row.content_hash)}::${String(row.content_hash_version)}`;
    table.rows.set(key, row);
  }

  private getTable(name: string): Table {
    const t = this.tables.get(name);
    if (!t) throw new Error(`FakeD1: no table ${name}`);
    return t;
  }

  /** STEP41 test hook: overwrite a stored knowledge block with garbage JSON so
   *  the provider's corrupt-omit path is exercised (real D1 TEXT could be
   *  edited out-of-band exactly this way). */
  corruptSoundCharacterV2(contentHash: string): void {
    const content = this.getTable("content");
    for (const row of content.rows.values()) {
      if (String(row.content_hash) === contentHash) {
        row.sound_character_v2 = "{ this is not valid json";
      }
    }
  }

  /** Test-only dump of all tables, for debugging statement shapes. */
  dumpTables(): Record<string, Array<Record<string, unknown>>> {
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const [name, t] of this.tables) {
      out[name] = [...t.rows.values()];
    }
    return out;
  }
}

/** Split on top-level `AND` (not inside parens). */
function splitTopLevel(str: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  const upper = str.toUpperCase();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && upper.startsWith(" AND ", i)) {
      out.push(cur.trim());
      cur = "";
      i += 4;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface FromParts {
  table1: string;
  alias1: string;
  joinClause: string | null;
  whereSql: string | null;
  orderSql: string | null;
  limit: string | null;
  offset: string | null;
}

/**
 * Parse the `FROM ...` tail of a SELECT into its clauses. Handles the exact
 * shapes the provider emits: optional single-char alias (only when followed by
 * JOIN), optional JOIN ... ON, WHERE, ORDER BY, LIMIT, OFFSET.
 */
function parseFrom(s: string): FromParts {
  const m =
    /^([a-z_]+)(?:\s+([a-z])(?=\s+JOIN\s+))?(?:\s+JOIN\s+([a-z_]+)\s+([a-z])\s+ON\s+(.+?)(?=(?:\s+WHERE\s+|\s+ORDER\s+BY\s+|\s+LIMIT\s+|\s+OFFSET\s+|$)))?(?:\s+WHERE\s+(.+?)(?=(?:\s+ORDER\s+BY\s+|\s+LIMIT\s+|\s+OFFSET\s+|$)))?(?:\s+ORDER\s+BY\s+(.+?)(?=(?:\s+LIMIT\s+|\s+OFFSET\s+|$)))?(?:\s+LIMIT\s+(.+?)(?=(?:\s+OFFSET\s+|$)))?(?:\s+OFFSET\s+(.+?))?$/is.exec(
      s,
    );
  if (!m) throw new Error(`FakeD1: unparsable FROM: ${s}`);
  return {
    table1: m[1],
    alias1: m[2] ?? m[1][0],
    joinClause: m[3] ? `${m[3]} ${m[4]} ON ${m[5]}` : null,
    whereSql: m[6] ?? null,
    orderSql: m[7] ?? null,
    limit: m[8] ?? null,
    offset: m[9] ?? null,
  };
}
