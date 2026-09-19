# Lean Math Agent — Project Guide

## What This Is

AI-powered Lean 4 math theorem prover + problem solver. Single-page Next.js app.
- User inputs a math problem in natural language (Chinese)
- System classifies problem type → dispatches to appropriate solver pipeline
- Theorem problems: autoformalize → enumerate methods → plan steps → best-first proof search → Lean 4 verify
- Computational problems: equation setup → SymPy solve → cross-validate → NL explanation
- Also handles: optimization (deterministic search), find-all-values (systematic enumeration)

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 15.5.2, React 19, Tailwind v4, shadcn/ui (Radix), KaTeX, Lucide icons |
| Backend | Next.js API Routes (TypeScript), Zod validation |
| LLM | OpenAI-compatible API (configurable via env), fallback chain, LRU cache |
| Lean | Lean 4 + Mathlib v4.33.1 + Batteries + Aesop, persistent server (JSON-line protocol) |
| Compute | Python SymPy HTTP microservice (9 endpoints) |
| State | In-memory Map + JSON disk persistence |
| Tests | Vitest (26 test files) |

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
    DiagramSvg.tsx                  # SVG geometry diagrams
    GeometryDiagram.tsx             # Interactive SVG geometry visualization
    Header.tsx                      # Navigation header (auth, locale, links)
    KnowledgeGraph.tsx              # Interactive Neo4j knowledge graph SVG
    LeanPane.tsx                    # Lean source viewer (full/step toggle)
    LocaleSwitcher.tsx              # Language selector (zh-CN / en-US)
    MathText.tsx                    # LaTeX rendering via KaTeX
    MethodDetail.tsx                # Method inspiration + pros/cons
    MethodList.tsx                  # Scrollable method list with confidence
    PricingCards.tsx                # Subscription plan cards
    ProblemGenerator.tsx            # Generate problems by grade/difficulty/domain
    StepPane.tsx                    # Proof step list with status badges
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
    evaluate/route.ts               # Multi-agent method scoring
    generate-problem/route.ts       # Problem generation by params
    intuition/route.ts              # Post-proof learning review
    knowledge/search/route.ts       # Knowledge graph search
    knowledge/graph/route.ts        # Knowledge graph subgraph
    knowledge/stats/route.ts        # Knowledge graph statistics
    payments/checkout/route.ts      # Stripe checkout session
    payments/webhook/route.ts       # Stripe webhook handler
    plan/route.ts                   # Method → proof step sequence
    prove-step/route.ts             # Single step + repair loop (≤3 retries)
    session/[id]/route.ts           # GET session state
    solve/route.ts                  # One-click pipeline (classifies + dispatches)
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
    config.ts                       # Locale configuration (zh-CN, en-US)
    index.ts                        # I18nProvider + useI18n hook
    zh-CN.ts                        # Chinese translations
    en-US.ts                        # English translations
  payments/
    stripe.ts                       # Stripe integration (plans, checkout, webhooks)
  knowledge/
    neo4j-client.ts                 # Neo4j driver + query functions
  geometry/
    clingo-solver.ts                # Clingo ASP geometry solver
  llm/
    client.ts                       # Core LLM client (retry, fallback, cache, Zod)
    config.ts                       # LLM config from env vars
    cache.ts                        # LRU response cache (SHA-256 keyed)
    logger.ts                       # Structured JSON logger
    usage-tracker.ts                # Token usage tracking
    prompts.ts                      # Legacy prompts (enumerate/plan/prove-step)
    agent-prompt.ts                 # Agent system prompts (6 roles + 10 domains)
    autoformalize.ts                # 5-layer autoformalization pipeline
    classify-problem.ts             # Problem type classifier
    enumerate.ts                    # Method enumeration
    equation-setup.ts               # Equation extraction from word problems
    evaluate.ts                     # Multi-method evaluation (critic scoring)
    generate-problem.ts             # Problem generation + answer verification
    intuition.ts                    # Two-pass intuition review
    nl-solution.ts                  # NL solution generation (per problem type)
    optimization-extract.ts         # Optimization structure extraction
    plan.ts                         # Proof step planning
    prove-step.ts                   # Step proof + repair loop
    answer-verifier.ts              # Programmatic answer verification
    compute-prompts.ts              # Compute pipeline prompts
  lean/
    assemble.ts                     # Assemble Lean source from steps
    lemma-cache.ts                  # Mathlib lemma index (20+ built-in)
    parse-log.ts                    # Lean error parser (8 error kinds)
    sandbox.ts                      # Lean verification (server + spawn fallback)
    server.ts                       # Persistent Lean server (JSON-line stdin/stdout)
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
    proof-search.ts                 # Best-first proof search engine

scripts/
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
  LeanServer.lean                   # Persistent server binary (JSON-line protocol)
  lakefile.toml                     # Lake build config (mathlib v4.33.1)

Dockerfile                          # Multi-stage Next.js build
Dockerfile.compute                  # Python compute server
docker-compose.yml                  # Service orchestration (web + compute + neo4j + nginx)
nginx.conf                          # Reverse proxy with rate limiting
.dockerignore                       # Docker build exclusions

tests/                              # 30 Vitest test files (+4 P3 tests)
components/ui/                      # 16 shadcn/ui primitives (+avatar, dropdown-menu, label)
```

## Key Patterns

- **All LLM outputs validated by Zod** — one resample on invalid JSON, then throw
- **Repair loop**: generate Lean code → compile → classify error → feed back → retry (max 3)
- **Sorry degradation**: unprovable steps get `sorry` annotations, pipeline continues
- **4 problem types**: computational | theorem | optimization | find_all_values
- **Dual solve paths**: `/api/solve` classifies and dispatches; individual endpoints for step-by-step control
- **Dark theme UI**: Chinese-first, LaTeX via KaTeX, warm academic color palette

## Environment Variables

See `.env.example`:
- `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` — LLM configuration
- `LLM_FALLBACK_*` — Fallback model configuration
- `LEAN_SANDBOX_PATH` — Path to lean-sandbox directory
- `LEAN_BUILD_TIMEOUT_MS` — Lean compilation timeout
- `LLM_RETRY_*`, `LLM_CACHE_*` — Retry and cache settings
- `COMPUTE_SERVER_URL` — Python SymPy server URL

## Running

```bash
npm run dev                    # Start Next.js dev server (Turbopack)
python scripts/compute-server.py  # Start SymPy compute server (port 8765)
npx vitest run                 # Run all 26 test files
npm run build                  # Production build
```

## Current Status & TODO

### ✅ Working
- Full theorem proof pipeline (autoformalize → enumerate → plan → prove → verify)
- Computational solver (equation setup → SymPy → cross-validate)
- Optimization solver (deterministic combinatorial search)
- Find-all-values solver (systematic search + completeness)
- Multi-agent evaluation (orchestrator + strategist + critic)
- Persistent Lean server with spawn fallback
- LLM client with fallback chain, caching, structured output
- Problem generator (by grade/difficulty/domain)
- Dark theme UI with KaTeX math rendering

### 🔲 High Priority (make existing features more usable)
1. **Proof step tree visualization** — Current StepPane is a flat list; should show tree structure with branching
2. **Session history sidebar** — List past sessions, click to restore (data is on disk but no UI)
3. **Real-time progress** — Replace polling with SSE or WebSocket for solve pipeline events
4. **Error UX** — Better error boundaries, loading states, retry buttons

### 🔲 Medium Priority (expand capabilities)
5. **Algebra step-by-step display** — `/api/solve` returns `solution_steps` but UI doesn't render them well
6. **Lean proof caching** — `lib/lean/` has no result cache; repeated verifications waste time
7. **Method comparison view** — Show side-by-side evaluation scores for enumerated methods
8. **Session persistence upgrade** — Replace JSON file store with SQLite or similar
9. **Test coverage gaps** — No API route integration tests, no frontend component tests

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

- UI text: Chinese (zh-CN)
- Code: English
- Types: All in `lib/types.ts`, Zod schemas in `lib/schemas.ts`
- API pattern: POST with JSON body, return `NextResponse.json()`
- State: `useReducer` in hooks, session store on server
- Styling: Tailwind v4 CSS variables, shadcn/ui primitives, no CSS modules
- Math: KaTeX for rendering, `$...$` inline, `$$...$$` display
