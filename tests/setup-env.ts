// Vitest setup: isolate every test file from the repository's `.data/`.
//
// The session store and LLM cache persist to paths taken from the
// environment. Without this, running the suite wrote real JSON files
// into `.data/sessions` and one test only passed when leftovers from earlier
// runs happened to be on disk. Each test file gets its own temp directory,
// removed when the file finishes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "lean-math-agent-test-"));

process.env.SESSION_STORE_PATH = path.join(root, "sessions");
process.env.LLM_CACHE_PATH = path.join(root, "llm-cache.json");
process.env.PROOF_MEMORY_PATH = path.join(root, "proof-memory.json");
process.env.PREMISE_INDEX_PATH = path.join(root, "premise-index.json"); // absent → curated seed only
// Never talk to a real compute server, LLM or Loogle from unit tests by accident.
delete process.env.COMPUTE_ENGINE_URL;
delete process.env.LOOGLE_URL;
delete process.env.LLM_PROVER_MODEL;
delete process.env.LLM_PLANNER_MODEL;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
