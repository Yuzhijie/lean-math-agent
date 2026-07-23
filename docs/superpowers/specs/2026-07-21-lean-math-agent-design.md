# Lean Math Agent — Design Spec

**Date:** 2026-07-21  
**Project:** `lean-math-agent`  
**Status:** Approved for implementation planning  

## Goal

Build a **runnable MVP** local Web agent that:

1. Takes a math problem in natural language (narrow domain).
2. Uses an LLM to **enumerate multiple solving methods**, classified and compared, with inspiration notes.
3. Lets the user **select** a method.
4. Produces a **step-by-step** solution in plain language.
5. Attaches a **Lean 4** fragment to each step and verifies the assembled proof with `lake build` (or equivalent).

## Product choices (locked)

| Decision | Choice |
|----------|--------|
| Deliverable | Runnable MVP (not research-only, not docs-only) |
| Domain | Natural-number / integer equalities and simple induction |
| UI | Local Web: left = plain steps, right = Lean, one-click verify |
| Generation | Full LLM + repair loop until compile succeeds (or budget exhausted) |
| Stack | Monolithic Next.js (App Router + Route Handlers) |
| Formal success | Selected method’s final `.lean` must pass local Lean check |

## Non-goals (MVP)

- Multi-user accounts / cloud Lean
- Automatic Mathlib lemma search beyond what the LLM emits
- Geometry diagrams / full contest-problem parsers
- Guaranteeing every out-of-domain problem formalizes

---

## §1 Architecture: pipeline and module boundaries

```text
User problem text
    ↓
[1] MethodEnumerator (LLM)
    → classified methods + inspiration + pros/cons
    ↓
User selects a method in UI
    ↓
[2] StepPlanner (LLM)
    → ordered step skeleton (plain goal + Lean goal per step)
    ↓
[3] StepProver (LLM, per step)
    → plain explanation + Lean snippet
    ↓
[4] LeanSandbox
    → assemble .lean → lake build
    → on failure, feed diagnostics back to StepProver (bounded retries)
    ↓
[5] UI
    → method tree / comparison, step pane, Lean pane, verify / retry / switch method
```

### Modules

| Module | Responsibility | Not responsible for |
|--------|----------------|---------------------|
| `MethodEnumerator` | Exhaustive-ish method list under fixed taxonomy; inspiration; comparison | Full proofs |
| `StepPlanner` | Break chosen method into provable steps | Final Lean |
| `StepProver` | One-step NL + Lean; repair from build logs | Invoking `lake` |
| `LeanSandbox` | Isolated Lake project, file assembly, `lake build`, diagnostics | Math reasoning |
| `SessionStore` | In-memory (or JSON) session state | Long-term multi-tenant storage |
| Web UI / API | Orchestration and presentation | Proof logic itself |

### Hard constraints

- Domain: `Nat` / `Int` equalities and simple induction.
- Success: assembled Lean for the chosen method builds.
- Soft failure: after max repairs, show red status + log + “switch method”.

---

## §2 Data model and API

### Method taxonomy (LLM must classify into these)

1. `rewrite` — rewrite / simplify (`rw`, `simp`, algebraic identities)
2. `calc` — equational chain
3. `induction` — induction on `Nat` (use `induction_strong` for strong induction variant)
4. `cases` — case split (zero/succ, sign, etc.)
5. `ring_or_linarith` — automation (`ring` / `linarith` / `omega` as available)
6. `constructive` — explicit witness construction
7. `contradiction` — proof by contradiction
8. `other` — must explain why it does not fit above

### Core types

```ts
MethodOption {
  id: string
  category: TaxonomyCategory
  title: string
  inspiration: string      // why this approach suggests itself
  pros: string
  cons: string
  lean_sketch: string      // short tactic preview, not a full proof
  confidence: number       // 0–1, UI sort hint only
}

ProofStep {
  index: number
  plain_goal: string
  lean_goal: string
  plain_explanation: string
  lean_code: string
  status: "pending" | "ok" | "fail"
  build_log?: string
}

Session {
  id: string
  problem_text: string
  methods: MethodOption[]
  selected_method_id?: string
  steps: ProofStep[]
  assembled_lean: string
  build_status: "idle" | "ok" | "fail" | "unavailable"
  comparison_summary?: string
}
```

### HTTP API (Next.js Route Handlers)

| Endpoint | Role |
|----------|------|
| `POST /api/enumerate` | Problem → `methods[]` + comparison summary |
| `POST /api/plan` | `session_id` + `method_id` → step skeleton |
| `POST /api/prove-step` | Prove step `i` (optional prior `build_log`) |
| `POST /api/verify` | Assemble file → `lake build` → status/log |
| `GET /api/session/:id` | Fetch session |

### Orchestration rules

- After method select → `plan`.
- UI “next step” or “generate all” → `prove-step`.
- `verify` anytime.
- Server-side repair: up to **N = 3** retries per step / verify cycle.
- All LLM outputs validated against **JSON schema**; one re-sample on invalid JSON; then return a clear error (never treat half Lean as success).

---

## §3 LeanSandbox, UI, error handling

### LeanSandbox

- Dedicated Lake project under the repo (e.g. `lean-sandbox/`), bootstrapped from a minimal template similar to existing `lean-demo`.
- Prefer `Init` / `Std` for MVP; add Mathlib only if gold problems require it.
- Each verify writes `Scratch/Session_<id>.lean` (or a temp worktree), runs `lake env lean` / targeted `lake build`, captures stdout/stderr.
- Assembly: fixed `header` (imports) + LLM `theorem` / `have` / `calc` bodies. LLM must not modify `lakefile.toml`.
- Timeout ~60s; concurrency limit 1–2 local builds.

### UI layout

```text
┌─────────────────────────────────────────────┐
│ Problem input | [Enumerate methods]         │
├──────────────┬──────────────────────────────┤
│ Method list  │ Inspiration / pros-cons      │
│ (category)   │ for selected method          │
├──────────────┼──────────────────────────────┤
│ Left: steps  │ Right: Lean full / step      │
│ plain prose  │ [Verify] [Retry step]        │
│ green/red    │ [Switch method]              │
│              │ Collapsible build log        │
└──────────────┴──────────────────────────────┘
```

- Steps appear only after a method is selected.
- Inspiration and trade-offs stay attached to the selected method, not jammed into the first viewport as marketing clutter.

### Error handling

| Case | Behavior |
|------|----------|
| Invalid LLM JSON | Resample once; then user-visible retry |
| Lean error | Parse relevant lines → feed `prove-step`; ≤3 tries |
| Timeout / Lean missing | Actionable install / path guidance; never fake success |
| Out-of-domain problem | Warn at enumerate time; allow attempt without guarantee |

---

## §4 Acceptance criteria and testing

### Must-pass acceptance

1. For an in-domain example (e.g. `∀ n, n + 0 = n` or a simple inductive equality), show **≥3** taxonomy-tagged methods with inspiration and pros/cons.
2. After selecting a method, show stepwise plain explanations each with a Lean fragment.
3. **Verify** succeeds on the happy path (`lake build` or equivalent); on failure, show log and allow retry.
4. If Lean is not installed, UI explains how to install / configure path.
5. Switching methods clears steps and re-runs `plan` without session bleed.

### Test layers

- **Unit:** JSON schema validation, Lean log parsing, header assembly.
- **Integration:** 3–5 gold problems through enumerate → select → prove → verify. CI may mock the LLM; local manual runs use real LLM + real Lake.
- **Initial gold set:** `n + 0 = n`, `0 + n = n`, `n + m = m + n` (induction), a simple `Int` equality, one intentional out-of-domain problem (must warn).

### One-line success definition

In-domain, a user can **see multiple methods → pick one → follow plain steps → see Lean on the right that actually compiles**.

---

## Implementation sketch (post-spec)

Suggested order after plan approval:

1. Scaffold Next.js app + session store stubs.
2. Add `lean-sandbox` Lake project and `/api/verify` against a hand-written gold `.lean`.
3. Wire LLM clients + schema validation for `enumerate` / `plan` / `prove-step`.
4. Build UI panes and repair loop.
5. Run gold-problem acceptance checklist.

LLM provider and API keys: configure via environment variables (e.g. `OPENAI_API_KEY` or compatible endpoint); do not commit secrets.

---

## Open points resolved in brainstorming

- Approach: Next.js monolith (not FastAPI split, not Gradio).
- Generation strategy: full LLM + compile-repair (not template-first).
- Domain narrowed so formal verification is realistic for MVP.
