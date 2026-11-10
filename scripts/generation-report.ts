/**
 * `npm run gen:report` — where question generation spends its candidates, time and money:
 * every stored bank generation (candidates and their checks) and the generation log (time per
 * stage, rounds, model usage, also for built-in runs) → bench/GENERATION.md. No model calls.
 *
 *   --banks dir   bank store (default BANK_STORE_PATH or .data/banks)
 *   --log file    generation log (default GENERATION_LOG_PATH or .data/generation-log.jsonl)
 *   --out file    report (default bench/GENERATION.md)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { generationReport } from "../lib/generation-report";
import type { Generation, Item } from "../lib/bank/types";
import type { GenerationLogEntry } from "../lib/generation-stats";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readBanks(root: string): (Generation & { template_text?: string })[] {
  const out: (Generation & { template_text?: string })[] = [];
  if (!existsSync(root)) return out;
  for (const owner of readdirSync(root)) {
    const ownerDir = path.join(root, owner);
    let banks: string[] = [];
    try {
      banks = readdirSync(ownerDir);
    } catch {
      continue;
    }
    for (const bank of banks) {
      const file = path.join(ownerDir, bank, "bank.sqlite");
      if (!existsSync(file)) continue;
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const items = new Map<string, Item>();
        for (const r of db.prepare("SELECT id, data FROM docs WHERE kind = 'item'").all() as { id: string; data: string }[]) items.set(r.id, JSON.parse(r.data));
        for (const r of db.prepare("SELECT data FROM docs WHERE kind = 'generation'").all() as { data: string }[]) {
          const g = JSON.parse(r.data) as Generation;
          const first = g.template?.item_ids?.[0];
          out.push({ ...g, ...(first && items.get(first) ? { template_text: items.get(first)!.stem } : {}) });
        }
      } finally {
        db.close();
      }
    }
  }
  return out;
}

function readLog(file: string): GenerationLogEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as GenerationLogEntry];
      } catch {
        return [];
      }
    });
}

const banks = arg("banks") ?? process.env.BANK_STORE_PATH ?? path.join(".data", "banks");
const logFile = arg("log") ?? process.env.GENERATION_LOG_PATH ?? path.join(".data", "generation-log.jsonl");
const outFile = arg("out") ?? path.join("bench", "GENERATION.md");
const generations = readBanks(banks);
const log = readLog(logFile);
const md = generationReport({ generations, log });
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, md + "\n");
console.log(`${generations.length} bank generation(s), ${log.length} logged run(s) → ${outFile}`);
