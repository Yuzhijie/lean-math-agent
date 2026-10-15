import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Session, MethodScore } from "./types";

const CURRENT_SCHEMA_VERSION = 1;

const store = new Map<string, Session>();
function getSessionsDir(): string {
  return process.env.SESSION_STORE_PATH ?? ".data/sessions";
}

export function _resetStoreForTests() {
  store.clear();
  sqliteStore?.close();
  sqliteStore = null;
  sqliteInit = null;
}

/** A new session, owned by `owner` (the signed-in user's id, or "local" without sign-in). */
export function createSession(problemText: string, owner?: string): Session {
  const now = Date.now();
  const session: Session = {
    id: randomUUID(),
    schema_version: CURRENT_SCHEMA_VERSION,
    ...(owner ? { owner } : {}),
    problem_text: problemText,
    pipeline_stage: "idle",
    formal_validated: false,
    validation_results: [],
    methods: [],
    steps: [],
    assembled_lean: "",
    build_status: "idle",
    sorry_labels: [],
    created_at: now,
    updated_at: now,
  };
  store.set(session.id, session);
  persist(session);
  return session;
}

/** Write a session to its backend; errors are dropped (the in-memory copy stays authoritative). */
function persist(session: Session): void {
  // JSON files: queue the write now, so writes keep their order (saveSessionToDisk serialises per session).
  if (!sqliteWanted()) {
    saveSessionToDisk(session.id).catch(() => {/* silent */});
    return;
  }
  void (async () => {
    try {
      if (await ensureBackend()) await sqliteStore!.save(store.get(session.id) ?? session);
      else await saveSessionToDisk(session.id);
    } catch {
      /* silent */
    }
  })();
}

export function getSession(id: string): Session | undefined {
  return store.get(id);
}

/**
 * Async version of getSession that falls back to disk when not in memory.
 * Use this in API routes to handle sessions that survive server reloads.
 */
export async function getSessionAsync(id: string): Promise<Session | undefined> {
  const mem = store.get(id);
  if (mem) return mem;
  // Fall back to loading from disk
  return loadSessionFromDisk(id);
}

export function updateSession(id: string, patch: Partial<Session>): Session {
  const cur = store.get(id);
  if (!cur) throw new Error(`session not found: ${id}`);
  const next = { ...cur, ...patch, id: cur.id, updated_at: Date.now() };
  store.set(id, next);
  // Auto-save so the session survives server reloads.
  persist(next);
  return next;
}

export function resetStepsForMethod(id: string, methodId: string): Session {
  return updateSession(id, {
    selected_method_id: methodId,
    steps: [],
    assembled_lean: "",
    build_status: "idle",
    sorry_labels: [],
    pipeline_stage: "solving",
  });
}

/** Return methods sorted by composite score (descending). */
export function getRankedMethods(id: string): MethodScore[] {
  const session = getSession(id);
  if (!session?.method_scores) return [];
  return [...session.method_scores].sort((a, b) => b.composite - a.composite);
}

/** Auto-select the best method by a given strategy. */
export function autoSelectMethod(
  id: string,
  strategy: "best_composite" | "most_feasible" = "best_composite",
): string | undefined {
  const ranked = getRankedMethods(id);
  if (ranked.length === 0) return undefined;
  if (strategy === "most_feasible") {
    return ranked.reduce((best, cur) =>
      cur.feasibility > best.feasibility ? cur : best,
    ).method_id;
  }
  return ranked[0].method_id;
}

// ── File-based persistence ────────────────────────────────────────────

/** Save a session to disk as JSON. */
export async function saveSessionToDisk(id: string): Promise<void> {
  if (await ensureBackend()) {
    const session = store.get(id);
    if (session) await sqliteStore!.save(session);
    return;
  }
  // Serialize writes per session and write atomically (temp file + rename):
  // updates fire in quick succession, and overlapping writeFile calls on the
  // same path used to leave files with two interleaved JSON documents.
  const prev = diskWrites.get(id) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const session = store.get(id);
      if (!session) return;
      await fs.mkdir(getSessionsDir(), { recursive: true });
      const filePath = path.join(getSessionsDir(), `${id}.json`);
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(session, null, 2), "utf8");
      await fs.rename(tmp, filePath);
    });
  diskWrites.set(id, next);
  try {
    await next;
  } finally {
    if (diskWrites.get(id) === next) diskWrites.delete(id);
  }
}

const diskWrites = new Map<string, Promise<void>>();

/** Load a session from disk into memory. */
export async function loadSessionFromDisk(id: string): Promise<Session | undefined> {
  if (await ensureBackend()) {
    const session = await sqliteStore!.load(id);
    if (session) store.set(id, session);
    return session;
  }
  try {
    const filePath = path.join(getSessionsDir(), `${id}.json`);
    const data = await fs.readFile(filePath, "utf8");
    const session = JSON.parse(data) as Session;
    store.set(id, session);
    return session;
  } catch {
    return undefined;
  }
}

/** Delete a session from disk and memory. */
export async function deleteSessionFromDisk(id: string): Promise<boolean> {
  try {
    if (await ensureBackend()) {
      await sqliteStore!.delete(id);
    } else {
      const filePath = path.join(getSessionsDir(), `${id}.json`);
      await fs.unlink(filePath);
    }
    store.delete(id);
    return true;
  } catch {
    return false;
  }
}

/** List saved sessions (sorted by created_at desc): one owner's, or all of them. */
export async function listSessionsFromDisk(owner?: string): Promise<Session[]> {
  if (await ensureBackend()) {
    return sqliteStore!.listAll(owner);
  }
  try {
    const files = await fs.readdir(getSessionsDir());
    const sessions: Session[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await fs.readFile(path.join(getSessionsDir(), file), "utf8");
        const s = JSON.parse(data) as Session;
        if (!owner || sessionOwner(s) === owner) sessions.push(s);
      } catch {
        // skip corrupted files
      }
    }
    return sessions.sort((a, b) => b.created_at - a.created_at);
  } catch {
    return [];
  }
}

// ── Pagination & Search ───────────────────────────────────────────────

export interface PaginatedResult {
  sessions: Session[];
  total: number;
  page: number;
  perPage: number;
}

/** List sessions with pagination support. */
export async function listSessionsPaginated(
  page: number = 1,
  perPage: number = 20,
  owner?: string,
): Promise<PaginatedResult> {
  if (await ensureBackend()) {
    return sqliteStore!.listPaginated(page, perPage, owner);
  }
  const all = await listSessionsFromDisk(owner);
  const total = all.length;
  const start = (page - 1) * perPage;
  const sessions = all.slice(start, start + perPage);
  return { sessions, total, page, perPage };
}

/** Search sessions by problem text or theorem name (server-side). */
export async function searchSessions(
  query: string,
  page: number = 1,
  perPage: number = 20,
  owner?: string,
): Promise<PaginatedResult> {
  if (await ensureBackend()) {
    return sqliteStore!.search(query, page, perPage, owner);
  }
  const all = await listSessionsFromDisk(owner);
  const q = query.toLowerCase();
  const filtered = all.filter(
    (s) =>
      s.problem_text.toLowerCase().includes(q) ||
      (s.theorem_name?.toLowerCase().includes(q) ?? false),
  );
  const total = filtered.length;
  const start = (page - 1) * perPage;
  const sessions = filtered.slice(start, start + perPage);
  return { sessions, total, page, perPage };
}

// ── SQLite Adapter ────────────────────────────────────────────────────

interface SqliteAdapter {
  save(session: Session): Promise<void>;
  load(id: string): Promise<Session | undefined>;
  delete(id: string): Promise<void>;
  listAll(owner?: string): Promise<Session[]>;
  listPaginated(page: number, perPage: number, owner?: string): Promise<PaginatedResult>;
  search(query: string, page: number, perPage: number, owner?: string): Promise<PaginatedResult>;
  clear(): Promise<void>;
  close(): void;
}

let sqliteStore: SqliteAdapter | null = null;
let sqliteInit: Promise<boolean> | null = null;

/** Sessions live in SQLite unless SESSION_BACKEND=json (the default before 2026-10). */
function sqliteWanted(): boolean {
  return (process.env.SESSION_BACKEND ?? "sqlite") === "sqlite";
}

/** Open the SQLite store once (lazily, on the first read or write); false = JSON files. */
async function ensureBackend(): Promise<boolean> {
  if (!sqliteWanted()) return false;
  if (sqliteStore) return true;
  sqliteInit ??= initSqliteStore();
  return sqliteInit;
}

/** Sessions written before owners existed belong to the local single user. */
export function sessionOwner(s: Pick<Session, "owner">): string {
  return s.owner ?? "local";
}

/**
 * Initialize the SQLite backend (`SQLITE_DB_PATH`, default `.data/sessions.db`). Runs on first use;
 * the first time the table is empty, the JSON session files are imported (and left in place).
 * Falls back to JSON files if better-sqlite3 cannot be loaded.
 */
export async function initSqliteStore(): Promise<boolean> {
  if (!sqliteWanted()) return false;
  try {
    const Database = (await import("better-sqlite3")).default;
    const dbPath = process.env.SQLITE_DB_PATH ?? ".data/sessions.db";
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        problem_text TEXT NOT NULL DEFAULT '',
        pipeline_stage TEXT NOT NULL DEFAULT 'idle',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);
    // Added 2026-10: sessions belong to a user.
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("owner")) db.exec(`ALTER TABLE sessions ADD COLUMN owner TEXT NOT NULL DEFAULT 'local'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions (created_at DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions (owner, created_at DESC)`);

    const stmtUpsert = db.prepare(
      `INSERT OR REPLACE INTO sessions (id, owner, problem_text, pipeline_stage, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const stmtSelect = db.prepare(`SELECT data FROM sessions WHERE id = ?`);
    const stmtDelete = db.prepare(`DELETE FROM sessions WHERE id = ?`);
    // `?1 IS NULL` = all owners (tools, tests); otherwise one owner's sessions.
    const ownerClause = `(?1 IS NULL OR owner = ?1)`;
    const stmtCount = db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE ${ownerClause}`);
    const stmtListAll = db.prepare(`SELECT data FROM sessions WHERE ${ownerClause} ORDER BY created_at DESC`);
    const stmtListPage = db.prepare(`SELECT data FROM sessions WHERE ${ownerClause} ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`);
    // Problem text or theorem name contains the query (case-insensitive for ASCII; no LIKE wildcards).
    const match = `(instr(lower(problem_text), lower(?2)) > 0 OR instr(lower(coalesce(json_extract(data, '$.theorem_name'), '')), lower(?2)) > 0)`;
    const stmtSearchCount = db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE ${ownerClause} AND ${match}`);
    const stmtSearchPage = db.prepare(`SELECT data FROM sessions WHERE ${ownerClause} AND ${match} ORDER BY created_at DESC LIMIT ?3 OFFSET ?4`);
    const parse = (rows: Array<{ data: string }>) => rows.map((r) => JSON.parse(r.data) as Session);
    const save = (session: Session) =>
      stmtUpsert.run(session.id, sessionOwner(session), session.problem_text, session.pipeline_stage, session.created_at, session.updated_at, JSON.stringify(session));

    // One-time import of the JSON files written before SQLite was the default.
    if ((stmtCount.get(null) as { count: number }).count === 0) {
      try {
        const files = (await fs.readdir(getSessionsDir())).filter((f) => f.endsWith(".json"));
        const sessions: Session[] = [];
        for (const f of files) {
          try {
            sessions.push(JSON.parse(await fs.readFile(path.join(getSessionsDir(), f), "utf8")) as Session);
          } catch {
            // a damaged file stays where it is
          }
        }
        db.transaction((all: Session[]) => all.forEach((x) => x.id && save(x)))(sessions);
      } catch {
        // no JSON sessions
      }
    }

    sqliteStore = {
      async save(session) {
        save(session);
      },
      async load(id) {
        const row = stmtSelect.get(id) as { data: string } | undefined;
        return row ? (JSON.parse(row.data) as Session) : undefined;
      },
      async delete(id) {
        stmtDelete.run(id);
      },
      async listAll(owner) {
        return parse(stmtListAll.all(owner ?? null) as Array<{ data: string }>);
      },
      async listPaginated(page, perPage, owner) {
        const { count } = stmtCount.get(owner ?? null) as { count: number };
        return { sessions: parse(stmtListPage.all(owner ?? null, perPage, (page - 1) * perPage) as Array<{ data: string }>), total: count, page, perPage };
      },
      async search(query, page, perPage, owner) {
        const { count } = stmtSearchCount.get(owner ?? null, query) as { count: number };
        const rows = stmtSearchPage.all(owner ?? null, query, perPage, (page - 1) * perPage) as Array<{ data: string }>;
        return { sessions: parse(rows), total: count, page, perPage };
      },
      async clear() {
        db.exec(`DELETE FROM sessions`);
      },
      close() {
        db.close();
      },
    };
    return true;
  } catch {
    sqliteStore = null;
    return false;
  }
}

/** Clear all sessions (both memory and disk). */
export async function clearAllSessions(): Promise<void> {
  store.clear();
  if (await ensureBackend()) {
    await sqliteStore!.clear();
  } else {
    try {
      const dir = getSessionsDir();
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          await fs.unlink(path.join(dir, file));
        }
      }
    } catch {
      // Directory may not exist
    }
  }
}
