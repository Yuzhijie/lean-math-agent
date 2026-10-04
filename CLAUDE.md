# Lean Math Agent — Project Guide

## What This Is

AI-powered Lean 4 math theorem prover + problem solver. Single-page Next.js app.
- User inputs a math problem in natural language (Chinese or English; UI and generated content follow the UI language)
- System classifies problem type → dispatches to appropriate solver pipeline
- Theorem problems: autoformalize (candidate voting + counterexample search) → premise retrieval + proof memory → hammer → whole-proof prover loop (sample → verify → repair with Lean feedback) → sketch-and-fill (holes closed by hammer / goal-level tactic search) → enumerate methods → plan steps → best-first proof search → Lean 4 verify
- Computational problems: equation setup → SymPy solve → cross-validate → NL explanation
- Also handles: optimization (deterministic search), find-all-values (systematic enumeration)

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, React 19, Tailwind v4, shadcn/ui (Radix), KaTeX, Lucide icons |
| Backend | Next.js API Routes (TypeScript), Zod validation |
| LLM | OpenAI-compatible API (configurable via env), role routing (general / prover / planner), sampling, fallback chain, LRU cache, per-run metrics |
| Lean | Lean 4 + Mathlib v4.33.1 + Batteries + Aesop; verification via persistent `leanprover-community/repl` workers (env reuse, sorry goals, tactic mode, axiom + statement checks), `lake env lean` fallback |
| Compute | Python SymPy HTTP microservice (9 endpoints) |
| State | In-memory Map + JSON disk persistence |
| Tests | Vitest (65 test files) |

## Project Structure

```
app/
  page.tsx                          # Single-page client app (useReducer state)
  layout.tsx                        # Root layout (fonts, dark theme, KaTeX CSS, providers)
  providers.tsx                     # SessionProvider wrapper (NextAuth + I18n)
  globals.css                       # Tailwind v4 theme + CSS variables + animations
  hooks/
    useProofSession.ts              # State machine (ProofSessionState + reducer)
    useProofActions.ts              # API action callbacks
  components/
    AuthButton.tsx                  # Login/logout dropdown with avatar
    BuildLog.tsx                    # Collapsible Lean build log
    DiagramSvg.tsx                  # Sanitized LLM SVG (problem generator)
    FigurePanel.tsx                 # Solution figure: fetches /api/figure, renders client-side, per-step highlights, check badge
    GeometryDiagram.tsx             # Interactive SVG geometry visualization
    Header.tsx                      # Navigation header (auth, locale, links)
    KnowledgeGraph.tsx              # Interactive Neo4j knowledge graph SVG
    LeanPane.tsx                    # Lean source viewer (full/step toggle)
    LocaleSwitcher.tsx              # Language button in the page header: follow system / 简体中文 / English
    MathText.tsx                    # LaTeX rendering via KaTeX
    MethodDetail.tsx                # Method inspiration + pros/cons
    MethodList.tsx                  # Scrollable method list with confidence
    PricingCards.tsx                # Subscription plan cards
    ProblemGenerator.tsx            # Problem generator: method 1 (default when a bank has questions) = local bank as template — Level/Difficulty/Topic pick bank questions sent to the model as the template, results with checks + "Add to bank"; method 2 = built-in by grade/difficulty/domain
    BankTemplateControls.tsx        # Level / Difficulty / Topic pickers from the bank (template-options), live count of matching template questions
    StepPane.tsx                    # Proof step list with status badges
  bank/page.tsx                     # Question bank page: banks + category tree, item list/editor, import wizard, generate panel
  auth/
    signin/page.tsx                 # Sign-in page (credentials + OAuth)
    signout/page.tsx                # Sign-out confirmation page
  subscription/
    page.tsx                        # Subscription plans + FAQ
  knowledge/
    page.tsx                        # Knowledge graph explorer
  api/
    auth/[...nextauth]/route.ts     # NextAuth handler
    autoformalize/route.ts          # NL → Lean theorem (5-layer validation)
    enumerate/route.ts              # Enumerate proof methods
    banks/…                         # Question banks: CRUD, imports (draft → review → commit), items, categories, profile, generate, generations (adopt), export, assets
    figure/route.ts                 # Figure for a session's problem (generate → solve coordinates → check claims; cached on the session)
    evaluate/route.ts               # Multi-agent method scoring
    generate-problem/route.ts       # Problem generation: source "bank" (local bank as template) or built-in by params
    intuition/route.ts              # Post-proof learning review
    knowledge/search/route.ts       # Knowledge graph search
    knowledge/graph/route.ts        # Knowledge graph subgraph
    knowledge/stats/route.ts        # Knowledge graph statistics
    payments/checkout/route.ts      # Stripe checkout session
    payments/webhook/route.ts       # Stripe webhook handler
    plan/route.ts                   # Method → proof step sequence
    prove-step/route.ts             # Single step + repair loop (≤3 retries)
    session/[id]/route.ts           # GET session state
    solve/route.ts                  # One-click pipeline (classifies + dispatches; theorem path in lib/pipeline)
    solve-compute/route.ts          # Standalone computational solver
    solve-geometry/route.ts         # Geometry solver (Clingo ASP)
    verify/route.ts                 # Final Lean verification

lib/
  types.ts                          # All domain types + constants (TAXONOMY, MATH_DOMAINS, etc.)
  schemas.ts                        # Zod schemas for all LLM outputs
  auth.ts                           # NextAuth configuration (JWT, providers, callbacks)
  db.ts                             # Prisma client singleton
  session-store.ts                  # In-memory + disk persistence
  utils.ts                          # cn() utility (clsx + tailwind-merge)
  math-segments.ts                  # Math text segmenter ($, $$, \(, \[)
  i18n/
    config.ts                       # Locales, system-language matching (Accept-Language / navigator.languages), `locale` cookie
    index.tsx                       # I18nProvider + useI18n: locale, pref (manual or "system"), t(key), tr(zh, en)
    zh-CN.ts                        # Chinese translations
    en-US.ts                        # English translations
  payments/
    stripe.ts                       # Stripe integration (plans, checkout, webhooks)
  knowledge/
    neo4j-client.ts                 # Neo4j driver + query functions
  geometry/
    clingo-solver.ts                # Clingo ASP geometry solver
  figure/
    spec.ts                         # FigureSpec Zod schema: constructions (triangle/square/midpoint/foot/intersection/circles/…), draw items, claims, axes, functions, step highlights
    solve.ts                        # Coordinates from constructions (triangle solver SSS/SAS/ASA/SSA + defaults, shape placement)
    check.ts                        # Numeric verification of claims + construction data → verified / sketch
    render.ts                       # Deterministic SVG (geometry, axes, function curves, angle/equal marks, highlights); runs in the browser
    expr.ts                         # Safe expression compiler for function plots (no eval)
    generate.ts                     # LLM → FigureSpec → solve/check → one repair round; keyword pre-filter
    logic.ts                        # Logic-puzzle diagrams: grid (matching), Venn (2–3 sets), ordering (row/circle), tree — exhaustive solve, uniqueness + answer checks
    logic-render.ts                 # SVG for logic diagrams (✓/✗ grid, Venn regions, seats, tree + leaf list)
  bank/                             # Customer question banks (试题库), stored per account under .data/banks/<owner>/<bank>/
    types.ts                        # Zod types: Bank, Item, Category (manual | filter | style template), ImportBatch/DraftItem, TemplateProfile, Generation/Candidate
    store.ts                        # Storage: one SQLite file per bank (better-sqlite3), JSONL fallback; owner isolation; BankError
    similarity.ts                   # Stem normalisation, fingerprints, BM25 near-duplicate search
    query.ts                        # Item filters, category membership
    vocab.ts                        # Built-in knowledge-point vocabularies (Australian Curriculum, 课标) + bank's own
    import/                         # Importers → draft batch: pdf.ts (unpdf text + question splitter + optional model tidy with verbatim check), tabular.ts (CSV/Excel column mapping), text.ts (Markdown/TXT), fields.ts, checks.ts (duplicates, missing fields)
    classify.ts                     # Model classification: catalogue path (2 levels, reuses existing categories), grade, knowledge points (snapped to vocab), difficulty 1–5; runs on import and via reclassify.ts (/api/banks/:id/classify)
    profile.ts                      # Template profile of a class (programmatic + model summary), exemplar selection
    generate.ts                     # Same-type generation (同类创编) from a category, picked items or style template; checks: format, independent answer, novelty vs bank, fit
    select.ts                       # Template selection by level/difficulty/topic (category incl. sub-categories, or knowledge point); widens difficulty ±1 → any → level any, never the topic; generator pickers (template-options)
    generator-bridge.ts             # /api/generate-problem source "bank": generation from a selection → GeneratedProblem cards with bank meta (checks, generation id)
    http.ts                         # bankRoute(): owner from NextAuth session (else "local"), request language, error mapping
  pipeline/
    theorem-pipeline.ts             # Theorem pipeline shared by /api/solve and /api/solve-stream
  prover/
    whole-proof.ts                  # Whole-proof loop: sample k proofs → verify → repair with feedback + suggestions
    sketch.ts                       # Sketch-and-fill: skeleton with `have … := by sorry` holes → each hole closed by hammer/goal search → splice → strict verify
    budget.ts                       # PROOF_BUDGET presets (low/normal/high) for whole-proof, sketch and goal search
    context.ts                      # Prover context: retrieved premises + recalled proofs as one prompt block; rememberVerifiedProof
  llm/
    client.ts                       # Core LLM client (roles, sampling, retry, fallback, cache, Zod)
    output-locale.ts                # Output language per request (ui_locale cookie): prompt switch for English, lt(zh, en), withRequestLocale
    config.ts                       # LLM config from env vars (role chains, prices)
    cache.ts                        # LRU response cache (SHA-256 keyed)
    logger.ts                       # Structured JSON logger
    usage-tracker.ts                # Usage records + per-run scope (RunMetrics)
    prompts.ts                      # Prompts (enumerate/plan/prove-step/whole-proof, Lean 4 pitfalls)
    agent-prompt.ts                 # Agent system prompts (6 roles + 10 domains)
    autoformalize.ts                # Autoformalization: candidate voting (AUTOFORMALIZE_CANDIDATES) + 6 validation layers (elaborate, refute, non-trivial, back-translate, numeric, relevance)
    classify-problem.ts             # Problem type classifier
    enumerate.ts                    # Method enumeration
    equation-setup.ts               # Equation extraction from word problems
    evaluate.ts                     # Multi-method evaluation (critic scoring)
    generate-problem.ts             # Problem generation + answer verification
    intuition.ts                    # Two-pass intuition review
    nl-solution.ts                  # NL solution generation (per problem type)
    optimization-extract.ts         # Optimization structure extraction
    plan.ts                         # Proof step planning
    prove-step.ts                   # Step proof (single + k sampled candidates) + repair loop
    answer-verifier.ts              # Programmatic answer verification
    compute-prompts.ts              # Compute pipeline prompts
  lean/
    assemble.ts                     # Assemble Lean source from steps
    lemma-cache.ts                  # Mathlib lemma index (20+ built-in)
    parse-log.ts                    # Lean error parser (8 error kinds)
    sandbox.ts                      # verifyLeanSource: sanitize → REPL/spawn → verdict (sorry, axioms, statement lock); autoImplicit off prelude
    repl.ts                         # leanprover-community/repl client: worker pool, header env reuse, tactic mode, timeouts
    proof-state.ts                  # ProofSession: pinned REPL worker, goal states as handles, apply tactic, replay on worker loss
    hammer.ts                       # Automation cascade (rfl/decide/simp/omega/norm_num/linarith/nlinarith hints/positivity/aesop/exact?)
    premises.ts                     # Premise retrieval: BM25 over Mathlib names/statements (built index + curated seed), similar-name hints
    premise-seed.ts                 # ~700 curated Mathlib lemmas used when no index is built
    proof-memory.ts                 # Verified proofs stored in .data/proof-memory.json; similar proofs recalled as worked examples
    refute.ts                       # Counterexample search for statements: `decide` on the negation, Mathlib `plausible`
    sanitize.ts                     # Forbidden-command filter (#eval, elab, unsafe, axiom, …) + statement validation
    axioms.ts                       # `#print axioms` / `#check` parsing, standard-axiom allowlist
    trivial-proof.ts                # Single-tactic proof attempts (with full verification)
    modernize.ts                    # Rewrites removed/Lean 3 syntax in model output (∑ x in s → ∑ x ∈ s, cases … with x → cases', λ x, e)
    feedback.ts                     # Verification result → proof-relative feedback for the model
    suggest.ts                      # exact?/apply?/simp? probes at the failing goal ("Try this" parsing)
    loogle.ts                       # Optional Loogle client (LOOGLE_URL) for unknown identifiers
    sorry-gate.ts                   # Sorry labeling + verification report
  agents/
    orchestrator.ts                 # Multi-agent orchestration (parallel fan-out)
    strategist.ts                   # Domain-specialist strategist agents
  compute/
    engine.ts                       # Compute engine facade (SymPy bridge + fallback)
    solver.ts                       # Computational solver pipeline
    cross-validate.ts               # Result cross-validation (tolerance clustering)
    optimization-solver.ts          # Deterministic optimization search
    find-all-solver.ts              # Systematic find-all-values + completeness proof
    sympy-bridge.ts                 # HTTP client to Python compute server
  search/
    priority-queue.ts               # Generic min-heap priority queue
    proof-search.ts                 # Best-first search: k candidates/step, parallel verify, goal dedupe, beam
    goal-search.ts                  # Goal-level best-first search in REPL tactic mode (hammer first, k sampled tactics/node, dedupe, beam, per-goal premises)
    bm25.ts                         # BM25 index + Mathlib-aware tokenizer (≤→le, *→mul, ^2→sq, ℕ→nat …)

bench/
  theorems.json                     # Benchmark statements (easy/medium/hard) for `npm run bench`
  minif2f-*.json                    # Downloaded by `npm run bench:fetch` (git-ignored)

scripts/
  bench.ts                          # Prover benchmark: cascade/whole_proof/sketch/stepwise, budgets, proved-by + failure taxonomy
  fetch-benchmark.ts                # miniF2F (Lean 4) → bench file (`npm run bench:fetch`)
  build-premise-index.ts            # Mathlib declaration dump → premise index (`npm run premises:build`)
  lean/DumpDecls.lean               # `lake env lean --run` script exporting theorem statements as JSON lines
  compute-server.py                 # Python SymPy HTTP server (9 POST endpoints)
  compute-server-v2.py              # Extended server with algebra module
  requirements.txt                  # Python dependencies (sympy, flask)
  acceptance-smoke.sh               # Smoke test script
  solve/
    __init__.py                     # Algebra solver package
    parser.py                       # Expression/equation parser (Chinese + English)
    steps.py                        # Step-by-step solution recorder
    solver.py                       # Main solver (linear, quadratic, poly, systems)
    endpoints.py                    # Flask HTTP endpoints

prisma/
  schema.prisma                     # Database schema (User, Subscription, ProofSession)

docs/
  P3-FEATURES.md                    # P3 features setup and usage guide

lean-sandbox/
  LeanSandbox.lean                  # Library root (imports Mathlib + Batteries + Aesop)
  lakefile.toml                     # Lake build config (mathlib v4.33.1 + repl v4.33.0 dependency)

Dockerfile                          # Multi-stage Next.js build
Dockerfile.compute                  # Python compute server
docker-compose.yml                  # Service orchestration (web + compute + neo4j + nginx)
nginx.conf                          # Reverse proxy with rate limiting
.dockerignore                       # Docker build exclusions

tests/                              # 65 Vitest test files (unit + fake REPL + real-Lean integration)
components/ui/                      # 16 shadcn/ui primitives (+avatar, dropdown-menu, label)
```

## Key Patterns

- **All LLM outputs validated by Zod** — one resample on invalid JSON, then throw
- **Whole-proof first**: the prover role samples complete proofs (`sampleText`, temperature 0.8, no cache) which are verified in parallel; the best failure is repaired with positioned errors / open goals (`lib/lean/feedback.ts`) plus `exact?`/`apply?`/`simp?` suggestions (`lib/lean/suggest.ts`); the statement is always re-assembled from the validated declaration
- **Repair loop**: generate Lean code → compile → classify error → feed back → retry (max 3); the prover is given the Lean goal state (from the verifier's sorry goals) for the step it is working on; the stepwise search samples k candidates per step, verifies them in parallel and branches on distinct goal states (beam-bounded)
- **REPL tactic mode**: `ProofSession` opens `theorem … := by sorry` once and applies tactics to goal-state handles (milliseconds per step, replayed if the worker dies); the hammer, goal-level search and sketch-and-fill all run on it. Every result is still re-assembled as text and passed through `verifyLeanSource`
- **Budget-aware LLM calls**: `expectedLatencyMs(role)` (EMA of observed call latencies, timeouts included) gates every repair round, goal-search expansion and sketch round — a call that cannot finish in the remaining budget is skipped rather than aborted (aborted calls still bill their tokens); tactic-step calls use `reasoningEffort: "low"` on reasoning models
- **Retrieval before generation**: `buildProverContext` (premises for the initial goal + verified proofs of similar theorems) feeds the whole-proof, sketch and goal-search prompts; goal search re-retrieves per node; unknown identifiers get "similar declarations" from the local index
- **Figures are computed, not drawn by the model**: the model writes a `FigureSpec` (what to construct and which conditions hold); `lib/figure` computes coordinates, checks every condition numerically and renders SVG. A figure whose conditions fail is shown as a sketch ("示意图"), never as accurate; figure checks are separate from Lean verification. Logic puzzles use `FigureSpec.logic` (grid/venn/ordering/tree): the program solves the puzzle exhaustively and checks uniqueness and the stated answer
- **Question banks**: imports never go straight in — every file becomes a draft batch that is reviewed (with a rights confirmation) before commit; the model only restructures PDF text and anything it rewrites is rejected in favour of the original. Generated questions are candidates with four checks (format, independent re-solve, novelty vs the bank, fit) and enter the bank only when adopted by hand, marked origin "generated". On import the model decides each question's catalogue place, grade, knowledge points and difficulty (`classified: {by: "model"}`); values present in the file are kept, everything stays editable in review, and missing categories are created on commit
- **Formalization reliability**: several sampled statements vote by elaborated signature (α-normalised); the winner must survive `decide`/`plausible` counterexample search (layer 6) before any LLM validation layer or proof search is spent on it
- **Roles + metrics**: `chatJson`/`sampleText` take `role: "prover" | "planner"`; endpoint chains come from `LLM_PROVER_*` / `LLM_PLANNER_*`; every solve runs in `withUsageScope`, and `verifyLeanSource` records itself, so responses/sessions carry `metrics` (calls, tokens, cost, verifications, wall time)
- **Sorry degradation**: unprovable steps get `sorry` annotations, pipeline continues
- **Trusted verification**: every source is sanitized (no `#eval`/`elab`/`unsafe`/`axiom`…); a complete proof counts only if Lean reports no errors, no `sorry` (textually AND via `#print axioms` — catches `admit`), only `propext`/`Classical.choice`/`Quot.sound`, and the proved statement's `#check` signature equals the one recorded when autoformalization was accepted (statement lock — the planner cannot change the theorem)
- **4 problem types**: computational | theorem | optimization | find_all_values
- **Dual solve paths**: `/api/solve` classifies and dispatches; individual endpoints for step-by-step control
- **Dark theme UI**: Chinese-first, LaTeX via KaTeX, warm academic color palette

## Environment Variables

See `.env.example`:
- `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` — LLM configuration
- `LLM_FALLBACK_*` — Fallback model configuration
- `LLM_PROVER_*` (incl. `LLM_PROVER_STEPWISE`), `LLM_PLANNER_*`, `LLM_PRICES` — role endpoints and cost table
- `LLM_REASONING_EFFORT`, `LLM_<ROLE>_REASONING_EFFORT`, `LLM_REASONING_TOKEN_BUDGET`, `LLM_SAMPLING_PARAMS`, `LLM_MAX_TOKENS_PARAM`, `LLM_REASONING_PARAM` — OpenAI reasoning-model dialect (GPT-5.x/GPT-6/o-series auto-detected: no temperature/top_p, `max_completion_tokens`, `reasoning_effort`; on openrouter.ai `max_tokens` + `reasoning: { effort }`)
- `WHOLE_PROOF_*`, `LEAN_SUGGEST_TIMEOUT_MS`, `LOOGLE_URL` — whole-proof loop, library search
- `PROOF_BUDGET`, `LEAN_TACTIC_TIMEOUT_MS`, `LEAN_HAMMER_BUDGET_MS`, `GOAL_SEARCH_*`, `SKETCH_*` — budgets, hammer, goal-level search, sketch-and-fill
- `PREMISES_ENABLED`, `PREMISE_INDEX_PATH`, `PREMISES_TOP_K`, `PROOF_MEMORY_*` — premise retrieval and proof memory
- `AUTOFORMALIZE_CANDIDATES`, `REFUTE_ENABLED`, `REFUTE_TIMEOUT_MS`, `REFUTE_TRIALS` — formalization voting and counterexample search
- `PROOF_SEARCH_SAMPLES`, `PROOF_SEARCH_BEAM`, `PROOF_SEARCH_MAX_EXPANSIONS`, `SOLVE_MULTI_AGENT` — stepwise search
- `LEAN_SANDBOX_PATH` — Path to lean-sandbox directory
- `LEAN_BUILD_TIMEOUT_MS` — Per-verification timeout
- `LEAN_SERVER_MODE` (`server` = REPL workers, `spawn` = `lake env lean` per file), `LEAN_REPL_WORKERS`, `LEAN_REPL_MAX_USES`, `LEAN_SERVER_STARTUP_MS`, `LEAN_ALLOW_NATIVE_DECIDE` — verification backend
- `LLM_RETRY_*`, `LLM_CACHE_*` — Retry and cache settings
- `COMPUTE_ENGINE_URL` — Python SymPy server URL

## Running

```bash
npm run dev                    # Start Next.js dev server (Turbopack)
python scripts/compute-server.py  # Start SymPy compute server (port 8765)
npx vitest run                 # Run all test files
npm run build                  # Production build
npm run bench -- --samples 4   # Prover benchmark over bench/theorems.json (LLM key + Lean sandbox required)
npm run bench:fetch            # Download miniF2F → bench/minif2f-test.json; then: npm run bench -- --file bench/minif2f-test.json --limit 20
npm run premises:build         # Index the sandbox's Mathlib for premise retrieval (minutes; needs the built sandbox)
```

## Current Status & TODO

### ✅ Working
- Full theorem proof pipeline (autoformalize → enumerate → plan → prove → verify)
- Computational solver (equation setup → SymPy → cross-validate)
- Optimization solver (deterministic combinatorial search)
- Find-all-values solver (systematic search + completeness)
- Multi-agent evaluation (orchestrator + strategist + critic)
- Lean REPL worker pool (env reuse, goal states, axiom + statement checks) with spawn fallback
- LLM client with role routing, sampling, fallback chain, caching, structured output, per-run metrics
- Whole-proof prover loop with Lean feedback + library-search suggestions; best-first stepwise search with sampled candidates
- REPL tactic mode: hammer cascade, goal-level best-first search, sketch-and-fill; premise retrieval + proof memory; formalization voting + counterexample search; miniF2F bench with failure taxonomy
- Problem generator (by grade/difficulty/domain)
- Dark theme UI with KaTeX math rendering

### 🔲 High Priority (make existing features more usable)
1. **Proof step tree visualization** — Current StepPane is a flat list; should show tree structure with branching
2. **Session history sidebar** — List past sessions, click to restore (data is on disk but no UI)
3. **Real-time progress** — Replace polling with SSE or WebSocket for solve pipeline events
4. **Error UX** — Better error boundaries, loading states, retry buttons

### 🔲 Medium Priority (expand capabilities)
5. **Algebra step-by-step display** — `/api/solve` returns `solution_steps` but UI doesn't render them well
6. **Method comparison view** — Show side-by-side evaluation scores for enumerated methods
7. **Session persistence upgrade** — Replace JSON file store with SQLite or similar
8. **Test coverage gaps** — No API route integration tests, no frontend component tests

### ✅ Low Priority (P3 — completed in v0.2.0)
10. **User authentication** (NextAuth) — `lib/auth.ts`, `app/api/auth/`, Prisma adapter
11. **Payment system** (Stripe/Alipay) — `lib/payments/stripe.ts`, checkout + webhook APIs
12. **Knowledge graph** (Neo4j) — `lib/knowledge/neo4j-client.ts`, search/graph/stats APIs
13. **Geometry solver** (Clingo ASP + construction) — `lib/geometry/clingo-solver.ts`
14. **Algebra solver module** (Python solve/ package) — `scripts/solve/` (parser, steps, solver)
15. **Docker deployment** — `Dockerfile`, `Dockerfile.compute`, `docker-compose.yml`, `nginx.conf`
16. **i18n bilingual support** — `lib/i18n/` (zh-CN, en-US), `LocaleSwitcher` component

See `docs/P3-FEATURES.md` for detailed setup and usage guide.

## Coding Conventions

- UI text: bilingual — every user-visible string is `tr("中文", "English")` from `useI18n()` (American English). The locale follows the OS/browser language; the header's language button overrides it (cookie `locale`, cleared by "follow system"). The root layout resolves the locale on the server (cookie → Accept-Language) so the first render matches
- Generated content follows the UI language: the browser keeps a `ui_locale` cookie; API routes are wrapped with `withRequestLocale` (lib/llm/output-locale.ts); for English, `rawChatMessages` switches the prompts' "Chinese" directives and appends an output-language instruction (prover/Lean calls: word switch only). Server-produced messages (progress events, summaries, check details, errors) use `lt("中文", "English")` at runtime — never at import time. Files bundled into the browser (lib/figure/logic.ts, render.ts, expr.ts, logic-render.ts, spec.ts) must not import output-locale; they take a `tr` parameter instead
- Code: English
- Types: All in `lib/types.ts`, Zod schemas in `lib/schemas.ts`
- API pattern: POST with JSON body, return `NextResponse.json()`
- State: `useReducer` in hooks, session store on server
- Styling: Tailwind v4 CSS variables, shadcn/ui primitives, no CSS modules
- Math: KaTeX for rendering, `$...$` inline, `$$...$$` display
