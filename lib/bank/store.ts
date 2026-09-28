/**
 * Local storage for question banks, isolated per account.
 *
 *   <root>/<owner key>/<bank id>/bank.sqlite   records (SQLite via better-sqlite3)
 *   <root>/<owner key>/<bank id>/*.jsonl       records (fallback when SQLite is unavailable)
 *   <root>/<owner key>/<bank id>/assets/       images, page renders, original import files
 *
 * <root> is BANK_STORE_PATH (default .data/banks). One folder per bank:
 * back it up, copy it or delete it as a unit. Records are JSON documents
 * of a few kinds (bank, item, category, batch, generation); a bank of
 * tens of thousands of questions fits comfortably in memory, so reads come
 * from a per-bank cache and every write goes straight to disk.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BANK_SCHEMA_VERSION,
  bankSchema,
  categorySchema,
  generationSchema,
  importBatchSchema,
  itemSchema,
  type Bank,
  type Category,
  type Generation,
  type ImportBatch,
  type Item,
  type ItemFields,
} from "./types";
import { fingerprint } from "./similarity";

export class BankError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface Kinds {
  bank: Bank;
  item: Item;
  category: Category;
  batch: ImportBatch;
  generation: Generation;
}
type Kind = keyof Kinds;
const KINDS: Kind[] = ["bank", "item", "category", "batch", "generation"];
const SCHEMAS = { bank: bankSchema, item: itemSchema, category: categorySchema, batch: importBatchSchema, generation: generationSchema };

export function storeRoot(): string {
  return process.env.BANK_STORE_PATH ?? path.join(".data", "banks");
}

/** Folder name for an owner: "local" stays readable, account ids are hashed. */
export function ownerKey(owner: string): string {
  if (owner === "local") return "local";
  return "u_" + createHash("sha256").update(owner).digest("hex").slice(0, 20);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function checkId(id: string, what = "id") {
  if (!SAFE_ID.test(id)) throw new BankError(`invalid ${what}`, 400);
}

// ── Per-bank document database ──────────────────────────────────────

interface Backend {
  load(kind: Kind): unknown[];
  put(kind: Kind, id: string, doc: unknown): void;
  remove(kind: Kind, id: string): void;
  close(): void;
}

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): Array<{ data: string }> };
  close(): void;
};

function openSqlite(dir: string): Backend | null {
  if (process.env.BANK_STORE_BACKEND === "jsonl") return null;
  let Database: (new (file: string) => SqliteDb) | undefined;
  try {
    // Optional dependency (also used by the session store).
    Database = require("better-sqlite3");
  } catch {
    return null;
  }
  try {
    const db = new Database!(path.join(dir, "bank.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, id))");
    const sel = db.prepare("SELECT data FROM docs WHERE kind = ?");
    const up = db.prepare("INSERT OR REPLACE INTO docs (kind, id, data, updated_at) VALUES (?, ?, ?, ?)");
    const del = db.prepare("DELETE FROM docs WHERE kind = ? AND id = ?");
    return {
      load: (kind) => sel.all(kind).map((r) => JSON.parse(r.data)),
      put: (kind, id, doc) => void up.run(kind, id, JSON.stringify(doc), Date.now()),
      remove: (kind, id) => void del.run(kind, id),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

function jsonlBackend(dir: string): Backend {
  const file = (kind: Kind) => path.join(dir, `${kind}.jsonl`);
  const cache = new Map<Kind, Map<string, unknown>>();
  const get = (kind: Kind) => {
    let m = cache.get(kind);
    if (!m) {
      m = new Map();
      if (fs.existsSync(file(kind))) {
        for (const line of fs.readFileSync(file(kind), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line) as { id: string };
            m.set(d.id, d);
          } catch {
            /* skip a torn line */
          }
        }
      }
      cache.set(kind, m);
    }
    return m;
  };
  const flush = (kind: Kind) => {
    const tmp = `${file(kind)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, [...get(kind).values()].map((d) => JSON.stringify(d)).join("\n") + "\n");
    fs.renameSync(tmp, file(kind));
  };
  return {
    load: (kind) => [...get(kind).values()],
    put: (kind, id, doc) => {
      get(kind).set(id, doc);
      flush(kind);
    },
    remove: (kind, id) => {
      get(kind).delete(id);
      flush(kind);
    },
    close: () => cache.clear(),
  };
}

class BankDb {
  private readonly backend: Backend;
  private readonly docs = new Map<Kind, Map<string, unknown>>();
  readonly backendName: "sqlite" | "jsonl";

  constructor(readonly dir: string) {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    const sqlite = openSqlite(dir);
    this.backend = sqlite ?? jsonlBackend(dir);
    this.backendName = sqlite ? "sqlite" : "jsonl";
  }

  private map<K extends Kind>(kind: K): Map<string, Kinds[K]> {
    let m = this.docs.get(kind);
    if (!m) {
      m = new Map();
      for (const raw of this.backend.load(kind)) {
        const parsed = SCHEMAS[kind].safeParse(raw);
        if (parsed.success) m.set((parsed.data as { id: string }).id, parsed.data);
      }
      this.docs.set(kind, m);
    }
    return m as Map<string, Kinds[K]>;
  }

  all<K extends Kind>(kind: K): Kinds[K][] {
    return [...this.map(kind).values()];
  }
  get<K extends Kind>(kind: K, id: string): Kinds[K] | undefined {
    return this.map(kind).get(id);
  }
  put<K extends Kind>(kind: K, doc: Kinds[K]): Kinds[K] {
    const valid = SCHEMAS[kind].parse(doc) as Kinds[K];
    const id = (valid as { id: string }).id;
    this.backend.put(kind, id, valid);
    this.map(kind).set(id, valid);
    return valid;
  }
  remove(kind: Kind, id: string) {
    this.backend.remove(kind, id);
    this.map(kind).delete(id);
  }
  close() {
    this.backend.close();
    this.docs.clear();
  }
}

// ── Store ───────────────────────────────────────────────────────────

const open = new Map<string, BankDb>();

function bankDir(owner: string, bankId: string) {
  checkId(bankId, "bank id");
  return path.join(storeRoot(), ownerKey(owner), bankId);
}

function db(owner: string, bankId: string): BankDb {
  const dir = bankDir(owner, bankId);
  let d = open.get(dir);
  if (!d) {
    if (!fs.existsSync(dir)) throw new BankError("bank not found", 404);
    d = new BankDb(dir);
    open.set(dir, d);
  }
  return d;
}

/** Close all open banks (tests). */
export function _closeAllBanks() {
  for (const d of open.values()) d.close();
  open.clear();
}

const now = () => Date.now();
const newId = () => randomUUID().replace(/-/g, "").slice(0, 20);

export function listBanks(owner: string): Bank[] {
  const dir = path.join(storeRoot(), ownerKey(owner));
  if (!fs.existsSync(dir)) return [];
  const out: Bank[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!SAFE_ID.test(name)) continue;
    try {
      const b = db(owner, name).get("bank", name);
      if (b && b.owner === owner) out.push(b);
    } catch {
      /* not a bank folder */
    }
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

export function createBank(owner: string, fields: { name: string; description?: string; language?: Bank["language"]; allow_model?: boolean; pin_language?: boolean; vocab?: string[] }): Bank {
  const id = newId();
  const dir = bankDir(owner, id);
  fs.mkdirSync(dir, { recursive: true });
  const d = new BankDb(dir);
  open.set(dir, d);
  const t = now();
  return d.put("bank", bankSchema.parse({ ...fields, id, owner, created_at: t, updated_at: t, schema_version: BANK_SCHEMA_VERSION }));
}

export function getBank(owner: string, bankId: string): Bank {
  const b = db(owner, bankId).get("bank", bankId);
  if (!b || b.owner !== owner) throw new BankError("bank not found", 404);
  return b;
}

export function updateBank(owner: string, bankId: string, patch: Partial<Pick<Bank, "name" | "description" | "language" | "allow_model" | "pin_language" | "vocab">>): Bank {
  const b = getBank(owner, bankId);
  return db(owner, bankId).put("bank", { ...b, ...patch, id: b.id, owner: b.owner, updated_at: now() });
}

export function deleteBank(owner: string, bankId: string) {
  getBank(owner, bankId);
  const dir = bankDir(owner, bankId);
  open.get(dir)?.close();
  open.delete(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

function touch(owner: string, bankId: string) {
  const d = db(owner, bankId);
  const b = d.get("bank", bankId);
  if (b) d.put("bank", { ...b, updated_at: now() });
}

// Items

export function listItems(owner: string, bankId: string): Item[] {
  getBank(owner, bankId);
  return db(owner, bankId).all("item").sort((a, b) => a.created_at - b.created_at);
}

export function getItem(owner: string, bankId: string, itemId: string): Item {
  getBank(owner, bankId);
  const it = db(owner, bankId).get("item", itemId);
  if (!it) throw new BankError("item not found", 404);
  return it;
}

export function addItems(
  owner: string,
  bankId: string,
  entries: Array<{ fields: ItemFields; origin: Item["origin"]; category_ids?: string[]; generated_from?: Item["generated_from"] }>,
): Item[] {
  getBank(owner, bankId);
  const d = db(owner, bankId);
  const t = now();
  const out = entries.map((e, i) =>
    d.put("item", {
      ...e.fields,
      id: newId(),
      bank_id: bankId,
      category_ids: e.category_ids ?? [],
      origin: e.origin,
      generated_from: e.generated_from,
      fingerprint: fingerprint(e.fields.stem),
      created_at: t + i,
      updated_at: t + i,
      schema_version: BANK_SCHEMA_VERSION,
    }),
  );
  touch(owner, bankId);
  return out;
}

export function updateItem(owner: string, bankId: string, itemId: string, patch: Partial<ItemFields> & { category_ids?: string[] }): Item {
  const it = getItem(owner, bankId, itemId);
  const next = { ...it, ...patch, id: it.id, bank_id: it.bank_id, updated_at: now() };
  next.fingerprint = fingerprint(next.stem);
  const saved = db(owner, bankId).put("item", next);
  touch(owner, bankId);
  return saved;
}

export function deleteItem(owner: string, bankId: string, itemId: string) {
  getItem(owner, bankId, itemId);
  db(owner, bankId).remove("item", itemId);
  touch(owner, bankId);
}

// Categories

export function listCategories(owner: string, bankId: string): Category[] {
  getBank(owner, bankId);
  return db(owner, bankId).all("category").sort((a, b) => a.created_at - b.created_at);
}

export function getCategory(owner: string, bankId: string, categoryId: string): Category {
  getBank(owner, bankId);
  const c = db(owner, bankId).get("category", categoryId);
  if (!c) throw new BankError("category not found", 404);
  return c;
}

export function putCategory(owner: string, bankId: string, fields: Omit<Category, "id" | "bank_id" | "created_at" | "updated_at"> & { id?: string }): Category {
  getBank(owner, bankId);
  const d = db(owner, bankId);
  const prev = fields.id ? d.get("category", fields.id) : undefined;
  if (fields.id && !prev) throw new BankError("category not found", 404);
  if (fields.parent_id && !d.get("category", fields.parent_id)) throw new BankError("parent category not found", 400);
  const t = now();
  return d.put("category", { ...prev, ...fields, id: prev?.id ?? newId(), bank_id: bankId, created_at: prev?.created_at ?? t, updated_at: t });
}

export function deleteCategory(owner: string, bankId: string, categoryId: string) {
  getCategory(owner, bankId, categoryId);
  const d = db(owner, bankId);
  // Children move up one level; items lose the assignment.
  for (const c of d.all("category")) if (c.parent_id === categoryId) d.put("category", { ...c, parent_id: null, updated_at: now() });
  for (const it of d.all("item")) if (it.category_ids.includes(categoryId)) d.put("item", { ...it, category_ids: it.category_ids.filter((x) => x !== categoryId) });
  d.remove("category", categoryId);
}

// Import batches

export function putBatch(owner: string, bankId: string, batch: Omit<ImportBatch, "id" | "bank_id" | "created_at" | "updated_at"> & { id?: string }): ImportBatch {
  getBank(owner, bankId);
  const d = db(owner, bankId);
  const prev = batch.id ? d.get("batch", batch.id) : undefined;
  if (batch.id && !prev) throw new BankError("import batch not found", 404);
  const t = now();
  return d.put("batch", { ...batch, id: prev?.id ?? newId(), bank_id: bankId, created_at: prev?.created_at ?? t, updated_at: t });
}

export function getBatch(owner: string, bankId: string, batchId: string): ImportBatch {
  getBank(owner, bankId);
  const b = db(owner, bankId).get("batch", batchId);
  if (!b) throw new BankError("import batch not found", 404);
  return b;
}

export function listBatches(owner: string, bankId: string): ImportBatch[] {
  getBank(owner, bankId);
  return db(owner, bankId).all("batch").sort((a, b) => b.created_at - a.created_at);
}

// Generations

export function putGeneration(owner: string, bankId: string, g: Omit<Generation, "id" | "bank_id" | "created_at"> & { id?: string; created_at?: number }): Generation {
  getBank(owner, bankId);
  return db(owner, bankId).put("generation", { ...g, id: g.id ?? newId(), bank_id: bankId, created_at: g.created_at ?? now() });
}

export function getGeneration(owner: string, bankId: string, generationId: string): Generation {
  getBank(owner, bankId);
  const g = db(owner, bankId).get("generation", generationId);
  if (!g) throw new BankError("generation not found", 404);
  return g;
}

// Assets

const SAFE_ASSET = /^[a-f0-9]{16,64}\.(png|jpe?g|gif|webp|svg|pdf|csv|xlsx|json|jsonl|md|txt)$/;

/** Save a file into the bank's assets folder; the name is its content hash (same file → same name). */
export function saveAsset(owner: string, bankId: string, data: Buffer, ext: string): string {
  getBank(owner, bankId);
  const e = ext.toLowerCase().replace(/^\./, "");
  const name = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${e}`;
  if (!SAFE_ASSET.test(name)) throw new BankError(`unsupported asset type .${e}`, 400);
  const file = path.join(bankDir(owner, bankId), "assets", name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, data);
  return name;
}

export function readAsset(owner: string, bankId: string, name: string): Buffer {
  getBank(owner, bankId);
  if (!SAFE_ASSET.test(name)) throw new BankError("asset not found", 404);
  const file = path.join(bankDir(owner, bankId), "assets", name);
  if (!fs.existsSync(file)) throw new BankError("asset not found", 404);
  return fs.readFileSync(file);
}

export function backendOf(owner: string, bankId: string): "sqlite" | "jsonl" {
  return db(owner, bankId).backendName;
}

export { KINDS };
