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

### OpenAI GPT-5.x (e.g. GPT-5.6 Luna)

```bash
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-5.6-luna
LLM_REASONING_EFFORT=medium      # none | minimal | low | medium | high | xhigh | max
LLM_TIMEOUT_MS=300000            # reasoning calls are slower
LLM_PRICES={"gpt-5.6-luna":{"input":0.2,"output":1.2}}
```

GPT-5.x, GPT-6 and o-series models are recognised by name: the client omits `temperature`/`top_p`
(rejected by these models unless `LLM_REASONING_EFFORT=none`), sends `max_completion_tokens`
instead of `max_tokens` (plus `LLM_REASONING_TOKEN_BUDGET` for hidden reasoning), and passes
`reasoning_effort`. Use `LLM_PROVER_REASONING_EFFORT=high` to spend more thinking on proofs only.

Through OpenRouter the same model is `LLM_BASE_URL=https://openrouter.ai/api/v1`,
`LLM_MODEL=openai/gpt-5.6-luna`, `LLM_API_KEY=sk-or-v1-…`; the effort is then sent as OpenRouter's
`reasoning: { effort }` object and the cap as `max_tokens`.

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

1. **Autoformalize and validate** the statement (its `#check` signature is locked). With
   `AUTOFORMALIZE_CANDIDATES>1` several formalizations are sampled and the statement most of
   them agree on (by elaborated signature) wins; the chosen statement is then attacked with
   `decide` (on its negation) and Mathlib's `plausible` random tester — a counterexample
   rejects the translation and is fed back into the next attempt.
2. **Premises and memory**: lemmas relevant to the initial goal are retrieved (BM25 over
   Mathlib names/statements — a curated seed is built in, `npm run premises:build` indexes the
   sandbox's Mathlib) and verified proofs of similar theorems are recalled from
   `.data/proof-memory.json`; both go into every prover prompt.
3. **Hammer**: `rfl`/`decide`/`simp`/`omega`/`norm_num`/`linarith`/`nlinarith [hints]`/
   `positivity`/`aesop`/`exact?` on the root goal in REPL tactic mode (milliseconds).
4. **Whole-proof loop**: sample `WHOLE_PROOF_SAMPLES` complete proofs from the prover, verify
   them all through the REPL, then repair the most promising failure for `WHOLE_PROOF_ROUNDS`
   rounds with Lean's positioned errors, open goals, `exact?`/`apply?`/`simp?` suggestions
   and similar-name hints for unknown lemma names (local index, or Loogle).
5. **Sketch-and-fill**: the prover writes a proof skeleton whose intermediate facts are
   `have … := by sorry` holes; the skeleton is elaborated once and every hole becomes a proof
   state closed independently by the hammer or a **goal-level best-first search** (k sampled
   tactics per node applied incrementally, goal dedupe, beam, per-goal premise retrieval).
   Closing scripts are spliced back and the whole proof is verified strictly.
6. Otherwise the stepwise pipeline: enumerate methods (single enumerator, or the multi-agent
   strategists + critic with `SOLVE_MULTI_AGENT=true` / `options.multi_agent`), plan steps,
   best-first search that samples `PROOF_SEARCH_SAMPLES` candidates per step and branches on
   distinct goal states, then a final verification.

`PROOF_BUDGET=low|normal|high` (or `options.budget`) scales the sampling, repair and search
limits of stages 4–5 together. Every accepted proof is stored in proof memory. Every solve
response and session carries `metrics`: LLM calls/tokens by role and model, an estimated cost
(`LLM_PRICES`), Lean verifications by backend and wall time.

### Question banks (试题库)

`/bank` keeps each customer's own questions locally, per signed-in account (`.data/banks/`). Import
PDF, JSON/JSONL, CSV, Excel or Markdown, or scans and photos: the file becomes a draft batch you review and
edit before committing, with duplicates flagged. Scanned PDFs and images (PNG, JPEG, WebP, GIF; several
photos at once for the pages of one paper) are read page by page by a vision model (`LLM_VISION_MODEL`,
otherwise the general model, which then must accept images): the text is transcribed verbatim with maths
in LaTeX, figures are cut out and attached to their question, and every question keeps its page image so
the reviewer can compare. This needs a bank that allows sending content to the model. "Use this
problem" on a bank question takes its figures to the solving page; when solving, the vision model
reads them once and its description (shown under the figure) is added to the problem text, so every
solving step has the figure's information.

When the template questions have figures (scans, photos), generation keeps them visual: the vision
model reads the template's figures and their style (colour or black-and-white, fonts, line weight,
frames such as dashed cut-out cards), and each new question comes with a figure the program draws from
the question's own data — clocks, number lines, bar charts, pictographs, tables, shapes on a grid,
fractions, groups of objects, geometry, or a layout of cards. The independent re-solve sees an exact
description of the drawn figure, so a figure that does not match the answer fails the checks. Only
when no kind fits does the model draw the figure itself; that figure is re-read by the vision model
and marked as model-drawn. Illustrations, logos and brand names from the template are never copied.
Tables are kept too: a table in a scanned question is stored as a table and shown as one, and when
the template questions have tables, every generated question gets a table of the same layout (new
data, cells to fill in shown as boxes); a question without one fails the figure check.
3D figures work the same way: stacks of small cubes (观察物体, counting cubes) are drawn in 3D from the
number of cubes in each column, with their front / left / right / top views or empty grids to draw a
view in, and solids (cube, cuboid, prisms, pyramids, cylinder, cone, sphere, hemisphere) are drawn with
hidden edges dashed and the given lengths on their edges. Block figures can be drawn as plain blocks
(like a building) with a half-cylinder, roof, pyramid, cylinder, cone or dome on top, and "here are the
plans — which 3D drawing is right?" questions get the plans and four 3D options, all drawn from data.
A figure the model writes wrongly is sent back to it once, with the error, before the checks. When the template questions have 3D figures,
every generated question must have one; a question without one fails the figure check.
When reading scans, the model first surveys each page (regions, reading order, what is decoration), then
transcribes it (reading clocks, scales and tallies carefully), then analyses every question as a
template: what the student has to do, what a new question of the same kind must keep, and exactly what
each figure shows. That analysis is saved on the question (editable in review and later) and is given to
the model whenever the question is used as a template. The model decides each question's place in the category
tree (e.g. Number › Fractions), its grade, knowledge points and difficulty; missing categories are created
on commit, and "AI classify" does the same for questions already in a bank. Organise questions in categories — a manual group,
a saved filter, or a style template that describes a type of question without source questions
(e.g. ICAS-style) — then generate new questions of the same type. Each candidate is checked (format,
an independent re-solve of the answer, similarity to the bank, fit to the type) and is added to the
bank only when you adopt it. Export writes JSONL that imports back.

The problem generator on the main page uses the bank first: pick Level, Difficulty and Topic (the
bank's own levels, categories and knowledge points) and the matching bank questions are sent to
the model as the template for new questions. If nothing matches exactly, the difficulty and then
the level are widened within the topic (and the result says so). "Built-in" is the original
generator by school level, difficulty and domain.

Third-party papers (e.g. ICAS) may only be imported with the publisher's permission; the import
wizard asks for that confirmation.

### Figures (图文并茂)

Solutions to geometry and function problems come with a figure. The model only describes the figure
(`lib/figure/spec.ts`: points built from triangles/squares/circles, midpoints, feet, intersections,
rotations …, plus the problem's conditions and which elements each solution step uses); the server
computes the coordinates, checks every condition numerically and the page renders SVG with per-step
highlighting. Failed conditions mark the figure as a sketch. `POST /api/figure { session_id }`.

Logic puzzles get a diagram the same way (`lib/figure/logic.ts`): the model describes the puzzle —
a matching grid (甲乙丙分别是…), a 2–3 set Venn diagram (喜欢…的有…人), a line-up or round-table
seating (排成一排、围坐、相邻), or a tree diagram (搭配、有多少种) — and the program solves it
exhaustively. The grid's ✓/✗ come from all solutions of the stated conditions, every Venn region is
solved from the counts, seatings are checked for uniqueness (rotations/mirror images counted once)
and trees are counted; the model's answer is checked against the result, and conditions it could
not encode are listed, so such a diagram is never shown as verified.

Trust does not change with any of this: a proof counts only when Lean reports no errors, no
`sorry` (textually and via `#print axioms`), only the standard axioms, and the proved
statement's signature equals the locked one; every body is checked with
`set_option autoImplicit false`.

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
| `npm run bench -- [--file bench/minif2f-test.json] [--strategy cascade\|whole_proof\|sketch\|stepwise] [--budget low\|normal\|high] [--limit n]` | Prover benchmark (needs an LLM key + built sandbox): pass rate by difficulty, which stage proved what, tokens/cost, Lean verifications and a failure taxonomy; writes `bench/results/*.json` |
| `npm run bench:fetch -- [--split test\|valid] [--limit n]` | Download miniF2F (Lean 4 port) into `bench/minif2f-<split>.json` for the bench |
| `npm run premises:build -- [--all] [--prefix Mathlib.NumberTheory …] [--defs]` | Dump theorem statements from the sandbox's Mathlib (`scripts/lean/DumpDecls.lean`) into the premise index (`PREMISE_INDEX_PATH`) |

## Docs

See `docs/` for product and design notes.
# lean-math-agent
