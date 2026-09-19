// Vitest setup: isolate every test file from the repository's `.data/`.
//
// The session store, proof cache and LLM cache persist to paths taken from
// the environment. Without this, running the suite wrote real JSON files
// into `.data/sessions` and one test only passed when leftovers from earlier
// runs happened to be on disk. Each test file gets its own temp directory,
// removed when the file finishes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "lean-math-agent-test-"));

process.env.SESSION_STORE_PATH = path.join(root, "sessions");
process.env.PROOF_CACHE_PATH = path.join(root, "proof-cache.json");
process.env.LLM_CACHE_PATH = path.join(root, "llm-cache.json");
// Never talk to a real compute server or LLM from unit tests by accident.
delete process.env.COMPUTE_ENGINE_URL;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
