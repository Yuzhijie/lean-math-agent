# Lean Math Agent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local Next.js MVP that enumerates Lean-friendly solving methods for Nat/Int equalities, lets the user pick one, generates plain-language steps with Lean 4 fragments, and verifies the assembled proof via `lake build`.

**Architecture:** Monolithic Next.js App Router. Route Handlers orchestrate LLM modules (`MethodEnumerator` → `StepPlanner` → `StepProver`) and a filesystem `LeanSandbox`. In-memory `SessionStore` holds problem/methods/steps. UI is a single page with method list, inspiration/pros-cons, left steps / right Lean, and verify controls.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Zod, Vitest, OpenAI-compatible chat API (env-configured), Lean 4 + Lake (local `lean-sandbox/`).

## Global Constraints

- Domain: Nat/Int equalities and simple induction only; warn on out-of-domain.
- LLM strategy: full generation + compile-repair; max **3** retries per step/verify cycle.
- Method taxonomy (exact): `rewrite` | `calc` | `induction` | `cases` | `ring_or_linarith` | `constructive` | `contradiction` | `other`.
- Lean: LLM must not modify `lakefile.toml`; fixed imports header only; prefer Init/Std (no Mathlib in MVP).
- Secrets: API keys via env only; never commit `.env*`.
- Spec source of truth: `docs/superpowers/specs/2026-07-21-lean-math-agent-design.md`.
- Commits: only when the user (or executing agent following this plan with user approval) requests; plan steps include suggested commit messages for when commits are allowed.

---

## File Structure

```text
lean-math-agent/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                          # main UI
│   ├── globals.css
│   └── api/
│       ├── enumerate/route.ts
│       ├── plan/route.ts
│       ├── prove-step/route.ts
│       ├── verify/route.ts
│       └── session/[id]/route.ts
├── lib/
│   ├── types.ts                          # Session, MethodOption, ProofStep, taxonomy
│   ├── schemas.ts                        # Zod schemas mirroring LLM JSON
│   ├── session-store.ts                  # in-memory Map store
│   ├── llm/
│   │   ├── client.ts                     # chatCompletion(messages, schemaName)
│   │   ├── prompts.ts                    # system/user prompts
│   │   ├── enumerate.ts                  # MethodEnumerator
│   │   ├── plan.ts                       # StepPlanner
│   │   └── prove-step.ts                 # StepProver + repair
│   └── lean/
│       ├── assemble.ts                   # header + theorem + steps → source
│       ├── sandbox.ts                    # write file, lake build, timeout
│       └── parse-log.ts                  # extract useful diagnostics
├── lean-sandbox/
│   ├── lakefile.toml
│   ├── lean-toolchain
│   ├── LeanSandbox.lean
│   ├── Main.lean                         # optional stub exe
│   └── Scratch/.gitkeep
├── tests/
│   ├── schemas.test.ts
│   ├── assemble.test.ts
│   ├── parse-log.test.ts
│   ├── session-store.test.ts
│   └── sandbox.integration.test.ts       # skipped if lake missing
├── gold/
│   └── nat_add_zero.lean                 # hand-written passing proof
├── .env.example
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

### Task 1: Scaffold Next.js app + shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.example`, `.gitignore`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `lib/types.ts`, `README.md`
- Test: `tests/types-smoke.test.ts`

**Interfaces:**
- Produces: `TaxonomyCategory`, `MethodOption`, `ProofStep`, `Session`, `BuildStatus` in `lib/types.ts`

- [ ] **Step 1: Initialize Next.js TypeScript app in repo root**

Run from `/Users/zhijieyu/Projects/lean-math-agent` (preserve existing `docs/`):

```bash
npx create-next-app@15 . --typescript --eslint --app --src-dir=false --tailwind=false --import-alias="@/*" --turbopack --yes
```

If create-next-app refuses non-empty dir, scaffold manually: write `package.json` with dependencies `next@15`, `react`, `react-dom`, `zod`; devDependencies `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `vitest`, `@vitejs/plugin-react`; scripts `dev`, `build`, `start`, `test`, `lint`.

- [ ] **Step 2: Write `lib/types.ts`**

```ts
export const TAXONOMY = [
  "rewrite",
  "calc",
  "induction",
  "cases",
  "ring_or_linarith",
  "constructive",
  "contradiction",
  "other",
] as const;

export type TaxonomyCategory = (typeof TAXONOMY)[number];

export type BuildStatus = "idle" | "ok" | "fail" | "unavailable";

export type StepStatus = "pending" | "ok" | "fail";

export interface MethodOption {
  id: string;
  category: TaxonomyCategory;
  title: string;
  inspiration: string;
  pros: string;
  cons: string;
  lean_sketch: string;
  confidence: number;
}

export interface ProofStep {
  index: number;
  plain_goal: string;
  lean_goal: string;
  plain_explanation: string;
  lean_code: string;
  status: StepStatus;
  build_log?: string;
}

export interface Session {
  id: string;
  problem_text: string;
  methods: MethodOption[];
  selected_method_id?: string;
  steps: ProofStep[];
  assembled_lean: string;
  build_status: BuildStatus;
  comparison_summary?: string;
  out_of_domain_warning?: string;
  created_at: number;
}
```

- [ ] **Step 3: Write failing smoke test**

```ts
// tests/types-smoke.test.ts
import { describe, it, expect } from "vitest";
import { TAXONOMY } from "@/lib/types";

describe("TAXONOMY", () => {
  it("has exactly eight categories from the spec", () => {
    expect(TAXONOMY).toEqual([
      "rewrite",
      "calc",
      "induction",
      "cases",
      "ring_or_linarith",
      "constructive",
      "contradiction",
      "other",
    ]);
  });
});
```

- [ ] **Step 4: Add vitest config and run test**

```ts
// vitest.config.ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
```

Run: `npx vitest run tests/types-smoke.test.ts`  
Expected: PASS

- [ ] **Step 5: Write `.env.example` and `.gitignore` entries**

`.env.example`:

```bash
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4.1
LEAN_SANDBOX_PATH=lean-sandbox
LEAN_BUILD_TIMEOUT_MS=60000
```

Ensure `.gitignore` includes `.env`, `.env.local`, `node_modules`, `.next`, `lean-sandbox/Scratch/Session_*.lean`.

- [ ] **Step 6: Commit (when user allows)**

```bash
git add package.json tsconfig.json next.config.ts vitest.config.ts lib/types.ts tests/types-smoke.test.ts app .env.example .gitignore README.md
git commit -m "$(cat <<'EOF'
chore: scaffold Next.js app and shared session types

EOF
)"
```

---

### Task 2: Zod schemas + SessionStore

**Files:**
- Create: `lib/schemas.ts`, `lib/session-store.ts`
- Test: `tests/schemas.test.ts`, `tests/session-store.test.ts`

**Interfaces:**
- Consumes: types from `lib/types.ts`
- Produces:
  - `enumerateResponseSchema`, `planResponseSchema`, `proveStepResponseSchema` (Zod)
  - `createSession(problemText: string): Session`
  - `getSession(id: string): Session | undefined`
  - `updateSession(id: string, patch: Partial<Session>): Session`
  - `resetStepsForMethod(id: string, methodId: string): Session`

- [ ] **Step 1: Write failing schema tests**

```ts
// tests/schemas.test.ts
import { describe, it, expect } from "vitest";
import { enumerateResponseSchema } from "@/lib/schemas";

describe("enumerateResponseSchema", () => {
  it("accepts a valid enumerate payload with ≥1 method", () => {
    const parsed = enumerateResponseSchema.parse({
      comparison_summary: "归纳最稳；rewrite 最短。",
      out_of_domain_warning: null,
      methods: [
        {
          id: "m1",
          category: "induction",
          title: "对 n 归纳",
          inspiration: "目标对全体自然数成立，结构上适合归纳。",
          pros: "覆盖所有 n，证明完整。",
          cons: "比 simp 啰嗦。",
          lean_sketch: "induction n <;> simp",
          confidence: 0.9,
        },
      ],
    });
    expect(parsed.methods).toHaveLength(1);
  });

  it("rejects unknown category", () => {
    expect(() =>
      enumerateResponseSchema.parse({
        comparison_summary: "x",
        methods: [
          {
            id: "m1",
            category: "magic",
            title: "t",
            inspiration: "i",
            pros: "p",
            cons: "c",
            lean_sketch: "s",
            confidence: 1,
          },
        ],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

Run: `npx vitest run tests/schemas.test.ts`  
Expected: FAIL resolving `@/lib/schemas`

- [ ] **Step 3: Implement `lib/schemas.ts`**

```ts
import { z } from "zod";
import { TAXONOMY } from "./types";

export const taxonomySchema = z.enum(TAXONOMY);

export const methodOptionSchema = z.object({
  id: z.string().min(1),
  category: taxonomySchema,
  title: z.string().min(1),
  inspiration: z.string().min(1),
  pros: z.string().min(1),
  cons: z.string().min(1),
  lean_sketch: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const enumerateResponseSchema = z.object({
  comparison_summary: z.string().min(1),
  out_of_domain_warning: z.string().nullable().optional(),
  methods: z.array(methodOptionSchema).min(1),
});

export const planStepSkeletonSchema = z.object({
  index: z.number().int().nonnegative(),
  plain_goal: z.string().min(1),
  lean_goal: z.string().min(1),
});

export const planResponseSchema = z.object({
  steps: z.array(planStepSkeletonSchema).min(1),
});

export const proveStepResponseSchema = z.object({
  plain_explanation: z.string().min(1),
  lean_code: z.string().min(1),
});
```

- [ ] **Step 4: Re-run schema tests — expect PASS**

Run: `npx vitest run tests/schemas.test.ts`

- [ ] **Step 5: Write session-store tests then implement**

```ts
// tests/session-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  getSession,
  updateSession,
  resetStepsForMethod,
  _resetStoreForTests,
} from "@/lib/session-store";

beforeEach(() => _resetStoreForTests());

describe("session-store", () => {
  it("creates and retrieves a session", () => {
    const s = createSession("prove n + 0 = n");
    expect(getSession(s.id)?.problem_text).toBe("prove n + 0 = n");
    expect(s.build_status).toBe("idle");
    expect(s.steps).toEqual([]);
  });

  it("resetStepsForMethod clears steps and sets method id", () => {
    const s = createSession("p");
    updateSession(s.id, {
      steps: [
        {
          index: 0,
          plain_goal: "g",
          lean_goal: "g",
          plain_explanation: "e",
          lean_code: "rfl",
          status: "ok",
        },
      ],
      assembled_lean: "old",
      build_status: "ok",
    });
    const next = resetStepsForMethod(s.id, "m2");
    expect(next.selected_method_id).toBe("m2");
    expect(next.steps).toEqual([]);
    expect(next.assembled_lean).toBe("");
    expect(next.build_status).toBe("idle");
  });
});
```

```ts
// lib/session-store.ts
import { randomUUID } from "node:crypto";
import type { Session } from "./types";

const store = new Map<string, Session>();

export function _resetStoreForTests() {
  store.clear();
}

export function createSession(problemText: string): Session {
  const session: Session = {
    id: randomUUID(),
    problem_text: problemText,
    methods: [],
    steps: [],
    assembled_lean: "",
    build_status: "idle",
    created_at: Date.now(),
  };
  store.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return store.get(id);
}

export function updateSession(id: string, patch: Partial<Session>): Session {
  const cur = store.get(id);
  if (!cur) throw new Error(`session not found: ${id}`);
  const next = { ...cur, ...patch, id: cur.id };
  store.set(id, next);
  return next;
}

export function resetStepsForMethod(id: string, methodId: string): Session {
  return updateSession(id, {
    selected_method_id: methodId,
    steps: [],
    assembled_lean: "",
    build_status: "idle",
  });
}
```

Run: `npx vitest run tests/session-store.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit (when user allows)**

```bash
git add lib/schemas.ts lib/session-store.ts tests/schemas.test.ts tests/session-store.test.ts
git commit -m "$(cat <<'EOF'
feat: add Zod LLM schemas and in-memory session store

EOF
)"
```

---

### Task 3: LeanSandbox (assemble, parse-log, lake verify)

**Files:**
- Create: `lean-sandbox/lakefile.toml`, `lean-sandbox/lean-toolchain`, `lean-sandbox/LeanSandbox.lean`, `lean-sandbox/Scratch/.gitkeep`, `gold/nat_add_zero.lean`, `lib/lean/assemble.ts`, `lib/lean/parse-log.ts`, `lib/lean/sandbox.ts`
- Test: `tests/assemble.test.ts`, `tests/parse-log.test.ts`, `tests/sandbox.integration.test.ts`

**Interfaces:**
- Produces:
  - `LEAN_HEADER: string`
  - `assembleLeanSource(opts: { theoremName: string; theoremType: string; stepCodes: string[] }): string`
  - `parseLeanLog(log: string): string` (trimmed diagnostics)
  - `checkLeanAvailable(): Promise<{ ok: true } | { ok: false; message: string }>`
  - `verifyLeanSource(sessionId: string, source: string): Promise<{ ok: boolean; log: string; status: BuildStatus }>`

- [ ] **Step 1: Create minimal Lake project**

`lean-sandbox/lean-toolchain` — pin to the machine’s working toolchain (currently Lean 4.32.0 on this host). Prefer copying from `elan show` active toolchain name, e.g.:

```text
leanprover/lean4:v4.32.0
```

If that tag is wrong for the install, run `elan show` and paste the active toolchain string verbatim.

`lean-sandbox/lakefile.toml`:

```toml
name = "lean_sandbox"
version = "0.1.0"
defaultTargets = ["LeanSandbox"]

[[lean_lib]]
name = "LeanSandbox"
```

`lean-sandbox/LeanSandbox.lean` (single root file, no submodules):

```lean
-- Library root. Session proofs live under Scratch/ and are checked via `lake env lean`.
theorem sandbox_ok : True := trivial
```

`gold/nat_add_zero.lean` (hand-written gold for later UI demos / integration):

```lean
theorem nat_add_zero (n : Nat) : n + 0 = n := by
  rfl
```

- [ ] **Step 2: Write assemble + parse-log unit tests (fail first)**

```ts
// tests/assemble.test.ts
import { describe, it, expect } from "vitest";
import { assembleLeanSource, LEAN_HEADER } from "@/lib/lean/assemble";

describe("assembleLeanSource", () => {
  it("prefixes fixed header and wraps steps in a theorem", () => {
    const src = assembleLeanSource({
      theoremName: "nat_add_zero",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["rfl"],
    });
    expect(src.startsWith(LEAN_HEADER)).toBe(true);
    expect(src).toContain("theorem nat_add_zero (n : Nat) : n + 0 = n := by");
    expect(src).toContain("rfl");
  });
});
```

```ts
// tests/parse-log.test.ts
import { describe, it, expect } from "vitest";
import { parseLeanLog } from "@/lib/lean/parse-log";

describe("parseLeanLog", () => {
  it("keeps error lines and drops noise", () => {
    const log = [
      "compiling...",
      "Scratch/Session_x.lean:12:4: error: unknown identifier 'rflf'",
      "warning: something mild",
    ].join("\n");
    const out = parseLeanLog(log);
    expect(out).toContain("error:");
    expect(out).toContain("rflf");
  });
});
```

- [ ] **Step 3: Implement assemble + parse-log**

```ts
// lib/lean/assemble.ts
export const LEAN_HEADER = `-- Generated by lean-math-agent. Do not edit lakefile.
`;

export function assembleLeanSource(opts: {
  theoremName: string;
  theoremType: string;
  stepCodes: string[];
}): string {
  const body = opts.stepCodes.map((c) => c.trim()).filter(Boolean).join("\n\n");
  return `${LEAN_HEADER}theorem ${opts.theoremName} ${opts.theoremType} := by
${indent(body || "sorry")}
`;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((line) => (line.length ? `  ${line}` : line))
    .join("\n");
}
```

```ts
// lib/lean/parse-log.ts
export function parseLeanLog(log: string): string {
  const lines = log.split(/\r?\n/);
  const useful = lines.filter(
    (l) => /error:/i.test(l) || /warning:/i.test(l) || /\.lean:\d+:\d+/i.test(l),
  );
  return (useful.length ? useful : lines.slice(-40)).join("\n").trim();
}
```

Run: `npx vitest run tests/assemble.test.ts tests/parse-log.test.ts`  
Expected: PASS

- [ ] **Step 4: Implement sandbox verify + integration test**

```ts
// lib/lean/sandbox.ts
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuildStatus } from "../types";
import { parseLeanLog } from "./parse-log";

const DEFAULT_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 60_000);

export function sandboxRoot(): string {
  return path.resolve(process.env.LEAN_SANDBOX_PATH ?? "lean-sandbox");
}

export async function checkLeanAvailable(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  try {
    await runCmd("lake", ["--version"], sandboxRoot(), 10_000);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message:
        "未检测到可用的 lake/Lean。请安装 elan（https://lean-lang.org/install/），确保 `lake --version` 可用，并检查 LEAN_SANDBOX_PATH。",
    };
  }
}

export async function verifyLeanSource(
  sessionId: string,
  source: string,
): Promise<{ ok: boolean; log: string; status: BuildStatus }> {
  const avail = await checkLeanAvailable();
  if (!avail.ok) {
    return { ok: false, log: avail.message, status: "unavailable" };
  }
  const root = sandboxRoot();
  const scratchDir = path.join(root, "Scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  const filePath = path.join(scratchDir, `Session_${sessionId}.lean`);
  await fs.writeFile(filePath, source, "utf8");
  try {
    const log = await runCmd(
      "lake",
      ["env", "lean", filePath],
      root,
      DEFAULT_TIMEOUT,
    );
    return { ok: true, log: parseLeanLog(log) || "ok", status: "ok" };
  } catch (e) {
    const log = e instanceof Error ? e.message : String(e);
    return { ok: false, log: parseLeanLog(log), status: "fail" };
  }
}

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${timeoutMs}ms\n${out}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(out || `exit ${code}`));
    });
  });
}
```

```ts
// tests/sandbox.integration.test.ts
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkLeanAvailable, verifyLeanSource } from "@/lib/lean/sandbox";
import { assembleLeanSource } from "@/lib/lean/assemble";

const lean = await checkLeanAvailable();

describe.runIf(lean.ok)("LeanSandbox integration", () => {
  it("accepts gold nat_add_zero proof", async () => {
    const gold = await fs.readFile(
      path.resolve("gold/nat_add_zero.lean"),
      "utf8",
    );
    const res = await verifyLeanSource("gold", gold);
    expect(res.status).toBe("ok");
    expect(res.ok).toBe(true);
  });

  it("rejects sorry-free bad proof", async () => {
    const src = assembleLeanSource({
      theoremName: "bad",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["exact absurd"],
    });
    const res = await verifyLeanSource("bad", src);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("fail");
  });
});
```

Run: `npx vitest run tests/sandbox.integration.test.ts`  
Expected: PASS if lake works; skipped tests if not (adjust `describe.runIf` accordingly — if Vitest version lacks `runIf`, use `const describeLean = lean.ok ? describe : describe.skip`).

- [ ] **Step 5: Commit (when user allows)**

```bash
git add lean-sandbox gold lib/lean tests/assemble.test.ts tests/parse-log.test.ts tests/sandbox.integration.test.ts
git commit -m "$(cat <<'EOF'
feat: add Lean sandbox assemble/verify path

EOF
)"
```

---

### Task 4: LLM client + MethodEnumerator + `POST /api/enumerate`

**Files:**
- Create: `lib/llm/client.ts`, `lib/llm/prompts.ts`, `lib/llm/enumerate.ts`, `app/api/enumerate/route.ts`
- Test: `tests/enumerate.test.ts` (mock fetch)

**Interfaces:**
- Produces:
  - `chatJson<T>(args: { system: string; user: string; schema: ZodType<T>; schemaName: string }): Promise<T>` — validates; on Zod failure, **one** resample; then throws
  - `enumerateMethods(problemText: string): Promise<z.infer<typeof enumerateResponseSchema>>`
  - `POST /api/enumerate` body `{ problem_text: string }` → `{ session_id, methods, comparison_summary, out_of_domain_warning? }`

- [ ] **Step 1: Implement LLM client**

```ts
// lib/llm/client.ts
import type { z } from "zod";

export class LlmError extends Error {}

export async function chatJson<T>(args: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
}): Promise<T> {
  const first = await rawChat(args.system, args.user);
  const once = tryParse(args.schema, first);
  if (once.ok) return once.value;
  const second = await rawChat(
    args.system,
    `${args.user}\n\nYour previous JSON was invalid for ${args.schemaName}: ${once.error}\nReturn ONLY valid JSON.`,
  );
  const twice = tryParse(args.schema, second);
  if (twice.ok) return twice.value;
  throw new LlmError(`Invalid LLM JSON for ${args.schemaName}: ${twice.error}`);
}

function tryParse<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const json = extractJson(text);
    return { ok: true, value: schema.parse(json) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : trimmed;
  return JSON.parse(raw);
}

async function rawChat(system: string, user: string): Promise<string> {
  const key = process.env.LLM_API_KEY;
  if (!key) throw new LlmError("LLM_API_KEY is not set");
  const base = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const model = process.env.LLM_MODEL ?? "gpt-4.1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    throw new LlmError(`LLM HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LlmError("LLM returned empty content");
  return content;
}
```

- [ ] **Step 2: Prompts + enumerate module**

```ts
// lib/llm/prompts.ts
export const ENUMERATE_SYSTEM = `You are a math teaching assistant specialized in Nat/Int equalities and induction.
Return JSON only. Classify each method into exactly one of:
rewrite, calc, induction, cases, ring_or_linarith, constructive, contradiction, other.
For each method provide: id, category, title, inspiration, pros, cons, lean_sketch, confidence (0-1).
Provide comparison_summary across methods.
If the problem is outside Nat/Int equalities/simple induction, set out_of_domain_warning to a short Chinese warning; otherwise null.
Aim for at least 3 methods when the problem is in-domain.
Write Chinese for title/inspiration/pros/cons/comparison_summary.`;

export const PLAN_SYSTEM = `You break a chosen proof method into ordered steps for Lean 4.
Return JSON: { "steps": [{ "index", "plain_goal", "lean_goal" }, ...] }.
plain_goal in Chinese; lean_goal is a short Lean goal description.
No full proof code yet.`;

export const PROVE_STEP_SYSTEM = `You write one proof step for Lean 4 (Init/Std only, no Mathlib).
Return JSON: { "plain_explanation": Chinese, "lean_code": Lean tactics/code for this step only }.
If build_log is provided, repair the lean_code to fix those errors.
Do not invent imports. Prefer rfl, simp, rw, induction, cases, calc, omega when appropriate.`;
```

```ts
// lib/llm/enumerate.ts
import { enumerateResponseSchema } from "../schemas";
import { chatJson } from "./client";
import { ENUMERATE_SYSTEM } from "./prompts";

export async function enumerateMethods(problemText: string) {
  return chatJson({
    system: ENUMERATE_SYSTEM,
    user: `Problem:\n${problemText}`,
    schema: enumerateResponseSchema,
    schemaName: "enumerateResponse",
  });
}
```

- [ ] **Step 3: API route**

```ts
// app/api/enumerate/route.ts
import { NextResponse } from "next/server";
import { enumerateMethods } from "@/lib/llm/enumerate";
import { createSession, updateSession } from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";

export async function POST(req: Request) {
  const body = (await req.json()) as { problem_text?: string };
  if (!body.problem_text?.trim()) {
    return NextResponse.json({ error: "problem_text required" }, { status: 400 });
  }
  const session = createSession(body.problem_text.trim());
  try {
    const result = await enumerateMethods(session.problem_text);
    const updated = updateSession(session.id, {
      methods: result.methods,
      comparison_summary: result.comparison_summary,
      out_of_domain_warning: result.out_of_domain_warning ?? undefined,
    });
    return NextResponse.json({
      session_id: updated.id,
      methods: updated.methods,
      comparison_summary: updated.comparison_summary,
      out_of_domain_warning: updated.out_of_domain_warning ?? null,
    });
  } catch (e) {
    const msg = e instanceof LlmError ? e.message : "enumerate failed";
    return NextResponse.json({ error: msg, session_id: session.id }, { status: 502 });
  }
}
```

- [ ] **Step 4: Mock unit test for extract/validate path**

Add `tests/enumerate.test.ts` that mocks `global.fetch` to return valid JSON and asserts `enumerateMethods` returns 1+ methods; second case returns invalid then valid on retry.

Run: `npx vitest run tests/enumerate.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit (when user allows)**

```bash
git add lib/llm app/api/enumerate tests/enumerate.test.ts
git commit -m "$(cat <<'EOF'
feat: add LLM enumerate API for solving methods

EOF
)"
```

---

### Task 5: StepPlanner + StepProver + plan/prove-step/verify/session APIs

**Files:**
- Create: `lib/llm/plan.ts`, `lib/llm/prove-step.ts`, `app/api/plan/route.ts`, `app/api/prove-step/route.ts`, `app/api/verify/route.ts`, `app/api/session/[id]/route.ts`
- Test: `tests/prove-repair.test.ts` (mock LLM + mock verify)

**Interfaces:**
- Produces:
  - `planSteps(problem, method): planResponse`
  - `proveOneStep(...): proveStepResponse`
  - `proveStepWithRepair(...)` loops ≤3: generate → assemble so far → verify → feed log
  - Routes per spec §2

- [ ] **Step 1: Implement plan + prove modules**

```ts
// lib/llm/plan.ts
import type { MethodOption } from "../types";
import { planResponseSchema } from "../schemas";
import { chatJson } from "./client";
import { PLAN_SYSTEM } from "./prompts";

export async function planSteps(problemText: string, method: MethodOption) {
  return chatJson({
    system: PLAN_SYSTEM,
    user: JSON.stringify({ problemText, method }, null, 2),
    schema: planResponseSchema,
    schemaName: "planResponse",
  });
}
```

```ts
// lib/llm/prove-step.ts
import type { MethodOption, ProofStep, Session } from "../types";
import { proveStepResponseSchema } from "../schemas";
import { assembleLeanSource } from "../lean/assemble";
import { verifyLeanSource } from "../lean/sandbox";
import { chatJson } from "./client";
import { PROVE_STEP_SYSTEM } from "./prompts";

const MAX_RETRIES = 3;

export async function proveOneStep(args: {
  problemText: string;
  method: MethodOption;
  steps: ProofStep[];
  stepIndex: number;
  buildLog?: string;
}) {
  const step = args.steps.find((s) => s.index === args.stepIndex);
  if (!step) throw new Error(`missing step ${args.stepIndex}`);
  return chatJson({
    system: PROVE_STEP_SYSTEM,
    user: JSON.stringify(
      {
        problemText: args.problemText,
        method: args.method,
        step,
        prior_steps: args.steps.filter((s) => s.index < args.stepIndex),
        build_log: args.buildLog ?? null,
      },
      null,
      2,
    ),
    schema: proveStepResponseSchema,
    schemaName: "proveStepResponse",
  });
}

export async function proveStepWithRepair(args: {
  session: Session;
  method: MethodOption;
  stepIndex: number;
  theoremType: string;
}): Promise<ProofStep> {
  const steps = [...args.session.steps];
  let buildLog: string | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const gen = await proveOneStep({
      problemText: args.session.problem_text,
      method: args.method,
      steps,
      stepIndex: args.stepIndex,
      buildLog,
    });
    const idx = steps.findIndex((s) => s.index === args.stepIndex);
    steps[idx] = {
      ...steps[idx],
      plain_explanation: gen.plain_explanation,
      lean_code: gen.lean_code,
      status: "pending",
    };
    const source = assembleLeanSource({
      theoremName: "problem",
      theoremType: args.theoremType,
      stepCodes: steps
        .filter((s) => s.index <= args.stepIndex)
        .sort((a, b) => a.index - b.index)
        .map((s) => s.lean_code)
        .filter(Boolean),
    });
    const result = await verifyLeanSource(args.session.id, source);
    if (result.ok) {
      steps[idx] = { ...steps[idx], status: "ok", build_log: result.log };
      return steps[idx];
    }
    buildLog = result.log;
    steps[idx] = { ...steps[idx], status: "fail", build_log: result.log };
  }
  return steps.find((s) => s.index === args.stepIndex)!;
}
```

Note: MVP needs a `theoremType` string. For Task 5, accept optional `theorem_type` in API body; default `"(n : Nat) : n + 0 = n"` only for smoke — better: have planner also return `theorem_type` in an extended schema.

- [ ] **Step 2: Extend plan schema with theorem_type**

Update `lib/schemas.ts`:

```ts
export const planResponseSchema = z.object({
  theorem_name: z.string().min(1).default("problem"),
  theorem_type: z.string().min(1),
  steps: z.array(planStepSkeletonSchema).min(1),
});
```

Store on session via optional fields — add to `Session`:

```ts
theorem_name?: string;
theorem_type?: string;
```

Update `lib/types.ts` accordingly and fix tests.

- [ ] **Step 3: Wire routes**

`POST /api/plan` body `{ session_id, method_id }` → calls `resetStepsForMethod`, `planSteps`, fills `steps` with empty explanations/`pending`, saves `theorem_*`.

`POST /api/prove-step` body `{ session_id, step_index }` → `proveStepWithRepair`, writes back step + `assembled_lean`.

`POST /api/verify` body `{ session_id }` → assemble all non-empty step codes → `verifyLeanSource` → update `build_status`.

`GET /api/session/[id]` → return session or 404.

Repair loop already inside `proveStepWithRepair`. `verify` does a final whole-proof check without extra LLM unless you add optional `{ repair: true }` — MVP: verify only reports status; user clicks retry step for repair.

- [ ] **Step 4: Unit test repair loop with mocks**

In `tests/prove-repair.test.ts`, mock `chatJson` / `verifyLeanSource` so first verify fails, second succeeds; assert exactly 2 attempts and final `status === "ok"`.

Run: `npx vitest run tests/prove-repair.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit (when user allows)**

```bash
git add lib/types.ts lib/schemas.ts lib/llm app/api tests/prove-repair.test.ts
git commit -m "$(cat <<'EOF'
feat: add plan, prove-step repair loop, and verify APIs

EOF
)"
```

---

### Task 6: Main Web UI

**Files:**
- Modify: `app/page.tsx`, `app/globals.css`, `app/layout.tsx`
- Create: `app/components/MethodList.tsx`, `app/components/MethodDetail.tsx`, `app/components/StepPane.tsx`, `app/components/LeanPane.tsx`, `app/components/BuildLog.tsx`

**Interfaces:**
- Consumes: all API routes above
- Produces: interactive single-page MVP matching spec §3 layout

- [ ] **Step 1: Implement client page state machine**

States: `idle → enumerated → planned → proving/verified`.

`app/page.tsx` (client component) responsibilities:
1. Textarea for problem + button「枚举解法」→ `POST /api/enumerate`
2. Show `out_of_domain_warning` banner if present
3. `MethodList` + `MethodDetail` (inspiration / pros / cons / comparison_summary)
4. On select → `POST /api/plan`
5. `StepPane` left / `LeanPane` right
6. Buttons:「证明本步」「全部逐步生成」「验证」「重试本步」「换解法」
7. `BuildLog` collapsible

Keep styling simple CSS variables in `globals.css` (readable, not purple-gradient AI slop). Light academic look: off-white paper ground, ink text, one accent (e.g. deep teal). No card farm in the hero; problem input is the primary top band.

- [ ] **Step 2: Manual UI checklist (no browser automation required in plan)**

With `npm run dev` and `.env.local` set:
1. Enter `证明对任意自然数 n，n + 0 = n`
2. Enumerate → ≥3 methods
3. Select induction or rewrite → steps appear
4. Prove steps → right pane Lean updates
5. Verify → green if lake ok
6. Switch method → steps cleared

- [ ] **Step 3: Commit (when user allows)**

```bash
git add app
git commit -m "$(cat <<'EOF'
feat: add local web UI for methods, steps, and Lean verify

EOF
)"
```

---

### Task 7: Gold acceptance + README

**Files:**
- Create: `gold/problems.json`, `scripts/acceptance-smoke.sh` (optional), update `README.md`
- Modify: tests if needed

**Interfaces:**
- Produces: documented acceptance procedure matching spec §4

- [ ] **Step 1: Write gold problem list**

```json
[
  { "id": "nat_add_zero", "text": "证明对任意自然数 n，n + 0 = n", "in_domain": true },
  { "id": "zero_add_nat", "text": "证明对任意自然数 n，0 + n = n", "in_domain": true },
  { "id": "add_comm", "text": "证明对任意自然数 n m，n + m = m + n", "in_domain": true },
  { "id": "int_neg_add", "text": "证明对任意整数 a，a + (-a) = 0", "in_domain": true },
  { "id": "geometry_ood", "text": "证明三角形内角和为 180 度", "in_domain": false }
]
```

- [ ] **Step 2: README — run instructions**

Document:
1. `npm install`
2. Install elan/Lean; `cd lean-sandbox && lake build`
3. Copy `.env.example` → `.env.local` and set `LLM_API_KEY`
4. `npm run dev` → http://localhost:3000
5. `npx vitest run`
6. Acceptance checklist from spec §4

- [ ] **Step 3: Run full unit suite**

Run: `npx vitest run`  
Expected: all non-skipped tests PASS

- [ ] **Step 4: Commit (when user allows)**

```bash
git add gold README.md scripts
git commit -m "$(cat <<'EOF'
docs: add gold problems and run/acceptance instructions

EOF
)"
```

---

## Spec coverage self-check

| Spec requirement | Task |
|------------------|------|
| Method enumeration + taxonomy + inspiration/pros/cons | Task 4 |
| User selects method | Task 6 |
| Step planner + plain steps | Task 5–6 |
| Per-step Lean + assemble | Task 3, 5 |
| lake verify + missing Lean message | Task 3, 5–6 |
| Repair ≤3 | Task 5 |
| Switch method clears steps | Task 2, 5–6 |
| Out-of-domain warning | Task 4, 6 |
| Gold problems / acceptance | Task 7 |
| Next.js monolith | Task 1 |
| No Mathlib required for MVP | Task 3 |

## Placeholder scan

No TBD/TODO left in task steps; theorem_type handled by extending plan schema in Task 5.

## Type consistency

- `MethodOption` / `ProofStep` / `Session` defined in Task 1, extended with `theorem_name` / `theorem_type` in Task 5.
- Zod schemas mirror those fields.
- API field names use `session_id`, `method_id`, `step_index`, `problem_text` consistently.
