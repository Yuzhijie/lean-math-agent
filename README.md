# Lean Math Agent

Interactive Lean 4 math problem solver (MVP). Domain: Nat/Int equalities.

## Prerequisites

- Node.js 18+
- [elan](https://github.com/leanprover/elan) (Lean 4 toolchain manager)

## Setup

```bash
npm install
```

Install Lean via elan if needed, then build the sandbox and the REPL used for verification:

```bash
cd lean-sandbox
lake exe cache get      # Mathlib .olean cache (much faster than building)
lake build              # LeanSandbox
lake build repl         # leanprover-community/repl → .lake/packages/repl/.lake/build/bin/repl
cd ..
```

Verification runs through persistent REPL workers (`LEAN_SERVER_MODE=server`, the default):
Mathlib is imported once per worker and reused, sorry goals are reported back to the
prover, and a proof is only accepted when it has no `sorry`/`admit`, depends only on the
standard axioms, and proves exactly the statement that autoformalization validated.
If the REPL binary is missing the app falls back to `lake env lean <file>` per verification.

Copy env template and set your LLM credentials:

```bash
cp .env.example .env.local
```

Required in `.env.local`:

| Variable | Purpose |
|----------|---------|
| `LLM_API_KEY` | API key for the LLM provider |
| `LLM_BASE_URL` | OpenAI-compatible base URL (default `https://api.openai.com/v1`) |
| `LLM_MODEL` | Model name (default `gpt-4.1`) |

Optional: `LEAN_SANDBOX_PATH`, `LEAN_BUILD_TIMEOUT_MS` (see `.env.example`).

### Prover model (recommended)

Every LLM call carries a role — `prover` (writes Lean), `planner` (formalize / plan / score)
or `general`. Roles without their own model use the general chain, so the app works with a
single `LLM_MODEL`; proof success rates improve a lot with a Lean-specialised open prover
served through an OpenAI-compatible API (vLLM, SGLang, Ollama, OpenRouter):

```bash
LLM_PROVER_MODEL=Goedel-LM/Goedel-Prover-V2-8B
LLM_PROVER_BASE_URL=http://localhost:8000/v1
LLM_PROVER_API_KEY=...
```

### How a theorem gets proved

1. Autoformalize and validate the statement (its `#check` signature is locked).
2. Try single tactics (`rfl`, `simp`, `omega`, …).
3. **Whole-proof loop**: sample `WHOLE_PROOF_SAMPLES` complete proofs from the prover, verify
   them all through the REPL, then repair the most promising failure for `WHOLE_PROOF_ROUNDS`
   rounds with Lean's positioned errors, open goals, `exact?`/`apply?`/`simp?` suggestions
   and (optionally) Loogle hits for unknown lemma names.
4. Otherwise the stepwise pipeline: enumerate methods (single enumerator, or the multi-agent
   strategists + critic with `SOLVE_MULTI_AGENT=true` / `options.multi_agent`), plan steps,
   best-first search that samples `PROOF_SEARCH_SAMPLES` candidates per step and branches on
   distinct goal states, then a final verification.

Every solve response and session carries `metrics`: LLM calls/tokens by role and model, an
estimated cost (`LLM_PRICES`), Lean verifications by backend and wall time.

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Tests

```bash
npx vitest run
```

Integration tests that call `lake`/`lean` are skipped automatically when the toolchain is not on `PATH`.

Quick smoke script (tests only):

```bash
bash scripts/acceptance-smoke.sh
```

## Gold problems

Manual acceptance uses the problems in [`gold/problems.json`](gold/problems.json):

| ID | Problem | In domain |
|----|---------|-----------|
| `nat_add_zero` | 证明对任意自然数 n，n + 0 = n | yes |
| `zero_add_nat` | 证明对任意自然数 n，0 + n = n | yes |
| `add_comm` | 证明对任意自然数 n m，n + m = m + n | yes |
| `int_neg_add` | 证明对任意整数 a，a + (-a) = 0 | yes |
| `geometry_ood` | 证明三角形内角和为 180 度 | no (expect out-of-domain warning) |

Hand-written Lean reference for sandbox integration: [`gold/nat_add_zero.lean`](gold/nat_add_zero.lean).

## Acceptance checklist (spec §4)

Run manually with `npm run dev`, a valid `LLM_API_KEY`, and `lake build` succeeding in `lean-sandbox`.

1. **Enumerate methods** — For an in-domain problem (e.g. `证明对任意自然数 n，n + 0 = n`), click **枚举解法**. Expect **≥3** taxonomy-tagged methods, each with inspiration and pros/cons.
2. **Plan steps** — Select a method. Expect stepwise plain-language explanations, each with a Lean fragment.
3. **Verify** — Complete steps and click **验证**. On the happy path, verification succeeds (`build_status` ok). On failure, the build log is shown and **重试本步** is available.
4. **Lean missing** — Without elan/Lean on `PATH`, the UI shows an unavailable banner with install guidance (no silent failure).
5. **Switch method** — Click **换解法**, pick another method. Steps clear and replan runs without carrying over the previous method's steps.

**Out-of-domain:** Use `geometry_ood` from `gold/problems.json`. Expect an out-of-domain warning at enumerate time; the app may still allow an attempt without guaranteeing success.

**Success definition:** In-domain, a user can see multiple methods → pick one → follow plain steps → see Lean on the right that actually compiles.

Automated tests cover schemas, log parsing, assembly, session store, and (when Lean is installed) sandbox verification. They do **not** replace the manual checklist above (LLM responses are non-deterministic).

> **Note:** The §4 checklist requires a real `LLM_API_KEY` and a working local Lean/lake install. Automated CI does not claim that manual LLM E2E acceptance has passed.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Next.js dev server (Turbopack) |
| `npm run build` / `npm start` | Production build / server |
| `npm test` | Same as `npx vitest run` |
| `npm run lint` | ESLint |
| `npm run bench -- [--stepwise] [--samples 4] [--rounds 2] [--only id,…]` | Prover benchmark over `bench/theorems.json` (needs an LLM key + built sandbox); writes `bench/results/*.json` |

## Docs

See `docs/` for product and design notes.
