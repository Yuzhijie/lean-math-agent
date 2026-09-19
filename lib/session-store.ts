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
}

export function createSession(problemText: string): Session {
  const now = Date.now();
  const session: Session = {
    id: randomUUID(),
    schema_version: CURRENT_SCHEMA_VERSION,
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
  return session;
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
  // Auto-save to disk so session survives server reloads
  if (sqliteStore) {
    sqliteStore.save(next).catch(() => {/* silent */});
  } else {
    saveSessionToDisk(id).catch(() => {/* silent */});
  }
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
  if (sqliteStore) {
    const session = store.get(id);
    if (session) await sqliteStore.save(session);
    return;
  }
  const session = store.get(id);
  if (!session) return;
  await fs.mkdir(getSessionsDir(), { recursive: true });
  const filePath = path.join(getSessionsDir(), `${id}.json`);
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), "utf8");
}

/** Load a session from disk into memory. */
export async function loadSessionFromDisk(id: string): Promise<Session | undefined> {
  if (sqliteStore) {
    const session = await sqliteStore.load(id);
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
    if (sqliteStore) {
      await sqliteStore.delete(id);
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

/** List all saved sessions from disk (sorted by created_at desc). */
export async function listSessionsFromDisk(): Promise<Session[]> {
  if (sqliteStore) {
    return sqliteStore.listAll();
  }
  try {
    const files = await fs.readdir(getSessionsDir());
    const sessions: Session[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await fs.readFile(path.join(getSessionsDir(), file), "utf8");
        sessions.push(JSON.parse(data) as Session);
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
): Promise<PaginatedResult> {
  if (sqliteStore) {
    return sqliteStore.listPaginated(page, perPage);
  }
  const all = await listSessionsFromDisk();
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
): Promise<PaginatedResult> {
  if (sqliteStore) {
    return sqliteStore.search(query, page, perPage);
  }
  const all = await listSessionsFromDisk();
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
  listAll(): Promise<Session[]>;
  listPaginated(page: number, perPage: number): Promise<PaginatedResult>;
  search(query: string, page: number, perPage: number): Promise<PaginatedResult>;
  clear(): Promise<void>;
}

let sqliteStore: SqliteAdapter | null = null;

/**
 * Initialize the SQLite backend. Call once at server startup.
 * Falls back silently to JSON if better-sqlite3 is not available.
 */
export async function initSqliteStore(): Promise<boolean> {
  const backend = process.env.SESSION_BACKEND;
  if (backend !== "sqlite") return false;

  try {
    // Dynamic import — better-sqlite3 is optional
    const Database = (await import("better-sqlite3")).default;
    const dbPath = process.env.SQLITE_DB_PATH ?? ".data/sessions.db";
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });

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

    // Create index for pagination/sorting
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_created
      ON sessions (created_at DESC)
    `);

    // Prepared statements
    const stmtUpsert = db.prepare(`
      INSERT OR REPLACE INTO sessions (id, problem_text, pipeline_stage, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const stmtSelect = db.prepare(`SELECT data FROM sessions WHERE id = ?`);
    const stmtDelete = db.prepare(`DELETE FROM sessions WHERE id = ?`);
    const stmtCount = db.prepare(`SELECT COUNT(*) as count FROM sessions`);
    const stmtListAll = db.prepare(`SELECT data FROM sessions ORDER BY created_at DESC`);
    const stmtListPage = db.prepare(
      `SELECT data FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    const stmtSearchCount = db.prepare(
      `SELECT COUNT(*) as count FROM sessions WHERE problem_text LIKE ? OR pipeline_stage LIKE ?`,
    );
    const stmtSearchPage = db.prepare(
      `SELECT data FROM sessions WHERE problem_text LIKE ? OR pipeline_stage LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );

    sqliteStore = {
      async save(session: Session) {
        stmtUpsert.run(
          session.id,
          session.problem_text,
          session.pipeline_stage,
          session.created_at,
          session.updated_at,
          JSON.stringify(session),
        );
      },
      async load(id: string) {
        const row = stmtSelect.get(id) as { data: string } | undefined;
        if (!row) return undefined;
        return JSON.parse(row.data) as Session;
      },
      async delete(id: string) {
        stmtDelete.run(id);
      },
      async listAll() {
        const rows = stmtListAll.all() as Array<{ data: string }>;
        return rows.map((r) => JSON.parse(r.data) as Session);
      },
      async listPaginated(page: number, perPage: number) {
        const offset = (page - 1) * perPage;
        const { count } = stmtCount.get() as { count: number };
        const rows = stmtListPage.all(perPage, offset) as Array<{ data: string }>;
        return {
          sessions: rows.map((r) => JSON.parse(r.data) as Session),
          total: count,
          page,
          perPage,
        };
      },
      async search(query: string, page: number, perPage: number) {
        const pattern = `%${query}%`;
        const offset = (page - 1) * perPage;
        const { count } = stmtSearchCount.get(pattern, pattern) as { count: number };
        const rows = stmtSearchPage.all(
          pattern,
          pattern,
          perPage,
          offset,
        ) as Array<{ data: string }>;
        return {
          sessions: rows.map((r) => JSON.parse(r.data) as Session),
          total: count,
          page,
          perPage,
        };
      },
      async clear() {
        db.exec(`DELETE FROM sessions`);
      },
    };

    return true;
  } catch {
    // better-sqlite3 not available or DB error — fall back to JSON
    sqliteStore = null;
    return false;
  }
}

/** Clear all sessions (both memory and disk). */
export async function clearAllSessions(): Promise<void> {
  store.clear();
  if (sqliteStore) {
    await sqliteStore.clear();
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
