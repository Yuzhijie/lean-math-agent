# Lean Math Agent — Project Guide

## What This Is

AI-powered Lean 4 math theorem prover + problem solver. Single-page Next.js app.
- User inputs a math problem in natural language (Chinese or English; UI and generated content follow the UI language)
- System classifies problem type → dispatches to appropriate solver pipeline
- Theorem problems: autoformalize (candidate voting + counterexample search) → premise retrieval + proof memory → hammer → memory replay (a similar theorem's verified proof, verbatim) → whole-proof prover loop (sample → verify → repair with Lean feedback) → sketch-and-fill (holes closed by hammer / goal-level tactic search) → enumerate methods → plan steps → best-first proof search → Lean 4 verify
- Computational problems: equation setup → SymPy solve → cross-validate → NL explanation; the Lean formalization step is started by hand from the Lean tab (`/api/lean-attempt`)
- Also handles: optimization (deterministic search), find-all-values (systematic enumeration)

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16.4, React 19.3, Tailwind v4, shadcn/ui (Radix), KaTeX 0.19, Lucide icons 1.x (no brand icons) |
| Backend | Next.js API Routes (TypeScript), Zod 4 validation (`z.record` takes key + value schemas; transforms are `ZodPipe`), Prisma 7 (SQLite via `@prisma/adapter-better-sqlite3`), next-auth v4 (v5 still beta), Stripe 23; Node ≥ 22.12 |
| LLM | OpenAI-compatible API (configurable via env), role routing (general / prover / planner / vision), image input, sampling, fallback chain, LRU cache, per-run metrics |
| Lean | Lean 4 + Mathlib v4.33.1 + Batteries + Aesop; verification via persistent `leanprover-community/repl` workers (env reuse, sorry goals, tactic mode, axiom + statement checks), `lake env lean` fallback |
| Compute | Python SymPy HTTP microservice (9 endpoints) |
| State | Sessions in SQLite (`.data/sessions.db`, each owned by a user; JSON files with SESSION_BACKEND=json), in-memory cache |
| Tests | Vitest 5 (116 test files) |

## Project Structure

```
app/
  page.tsx                          # Single-page client app (useReducer state); a "what to do" switch at the top (求解一道题 / 从题库出题 / 内置出题): on ≥1280px the generator and the solver sit side by side, narrower screens show one (the generator stays mounted, so its results survive); "使用此题" switches to solving on narrow screens and scrolls to the problem card (the preview's figure is rebuilt for every used problem — `usedKey` — so a new question never keeps the previous question's figure); result grids use container queries (@2xl/@4xl) so they fit a half-width column. History sidebar on wide screens (≥1280px solving, ≥1760px next to the generator; History button shows/hides it, remembered in localStorage; slide-out panel on narrower screens; latest generation summary on top; sessions cannot be opened while something runs). Problem box: examples while empty/untouched (ProblemExamples), paste / drop / upload a picture of a problem → /api/read-problem-image fills the text and keeps the image + figure description (sent as figure_text), live preview under the box (options one per line, the figure stays while editing, "移除图形"), tooltips on Solve / Enumerate. "导出 PDF" on the problem card: a question used from a bank generation (?bank&gen&cand, text unchanged) opens /print for that candidate (scope can widen to the whole generation); any other problem is handed over in localStorage with its figure (SVG or images), without its answer. "导出 PDF" on the natural-language solution: a solution sheet (kind "solution": problem + figure, the solution figure as shown — the largest non-icon SVG in the figure panel —, the steps with sub-steps and key formulas, optional check, the final answer last)
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
    FigurePanel.tsx                 # Solution figure: fetches /api/figure, renders client-side, per-step highlights, check badge; step bar with previous/next and the step's title (controlled `step` linked to the solution's step cards, which get a "看图" button for steps that change the figure), slider + live read-outs for graph_explore
    GeometryDiagram.tsx             # Interactive SVG geometry visualization
    Header.tsx                      # Navigation header (auth, locale, links)
    KnowledgeGraph.tsx              # Interactive Neo4j knowledge graph SVG
    LeanPane.tsx                    # Lean source viewer (full/step toggle)
    LocaleSwitcher.tsx              # Language button in the page header: follow system / 简体中文 / English
    MathText.tsx                    # LaTeX rendering via KaTeX
    MethodDetail.tsx                # Method inspiration + pros/cons
    MethodList.tsx                  # Scrollable method list with confidence
    PricingCards.tsx                # Subscription plan cards
    ProblemGenerator.tsx            # Problem generator: method 1 (default when a bank has questions) = local bank as template — Level/Difficulty/Topic pick bank questions sent to the model as the template (2–10 matching questions: each is a template of its own, generated from in turn, the count is per template and the field says "每个模板"; more than 10: one generation from the whole set), results with checks + "Add to bank"; method 2 = built-in by grade/difficulty/domain. Bank mode streams progress (`stream: true` → NDJSON progress/result/error lines; round, stage chips, elapsed time); the result summary says "N requested, M passed, K failed (show)"; each card shows a status (可用 / 需人工看 / 未通过) and its failed or to-review checks inline (lib/bank/generation-view.ts); actions: one main button ("加入题库" for bank questions, else "使用此题"), hints/answer as icon toggles, formalize under "⋯"; figures are thumbnails (QuestionFigure `compact`, max 14rem) that open full size in a dialog (also on the bank page); "导出 PDF" under the result summary opens the printable worksheet (bank results by generation id, built-in results handed over in localStorage)
    BankTemplateControls.tsx        # Level / Difficulty / Topic pickers from the bank (template-options), live count of matching template questions
    StepPane.tsx                    # Proof step list with status badges
    PipelineProgress.tsx            # Live stage timeline of a solve (labels incl. queued/budget/retrieval/whole_proof/sketch/cancelled), queue place and a Cancel button while it runs
    SessionHistory.tsx              # Past sessions: SessionHistoryList (search, list, pagination; compact, disabled, current) in the page sidebar and in the slide-out Sheet
    ProblemExamples.tsx             # Example problems (compute, geometry, proof, optimize, word problem) under an empty problem box
  bank/page.tsx                     # Question bank page: banks + category tree, item list/editor, import wizard, generate panel (a category is one template; several selected questions are generated from one by one, each its own template and generation — lib/bank/template-runs.ts, at most 10 —, results grouped per template; "导出 PDF" next to each group's candidates opens the printable worksheet for that generation)
  print/page.tsx                    # Printable worksheet of generated questions (/print?bank=&gen=[&ids=] or ?key= from localStorage): toolbar (not printed) for title (= PDF file name), which questions (picked / passed the checks / all), answers (none by default / separate answer page / after each question), worked solutions, one question per page, name/date/score line; A4 print styles; "打印 / 保存为 PDF" → window.print(), the user picks "Save as PDF". Solution sheets (?key=, kind "solution") print the problem, the solution figure on its dark panel (print-color-adjust: exact), "解题过程" and the answer box at the end; toolbar: solution figure, check
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
    read-problem-image/route.ts     # POST multipart `image`: the vision model transcribes the problem (lib/problem-image.ts) and describes its figure; nothing stored
    generate-problem/route.ts       # Problem generation: source "bank" (local bank as template) or built-in by params; bank + `stream: true` → NDJSON progress lines (GenerationProgress), then the result
    intuition/route.ts              # Post-proof learning review
    lean-attempt/route.ts           # Last solving step, started by hand: Lean 4 formalization of a solved computational / optimization / find-all problem
    knowledge/search/route.ts       # Knowledge graph search
    knowledge/graph/route.ts        # Knowledge graph subgraph
    knowledge/stats/route.ts        # Knowledge graph statistics
    payments/checkout/route.ts      # Stripe checkout session
    payments/webhook/route.ts       # Stripe webhook handler
    plan/route.ts                   # Method → proof step sequence
    prove-step/route.ts             # Single step + repair loop (≤3 retries)
    session/[id]/route.ts           # GET / DELETE one of the caller's sessions
    sessions/route.ts               # The caller's sessions (paged, search)
    jobs/route.ts                   # GET the caller's solve jobs (running, queued with place, recently ended)
    jobs/[id]/cancel/route.ts       # POST cancel one of the caller's jobs
    quota/route.ts                  # GET the caller's plan and usage (solves this month, spend today)
    health/route.ts                 # GET public health check (Lean available, config sound, compute reachable) → 200 / 503; docker HEALTHCHECK
    solve/route.ts                  # One-click pipeline (classifies + dispatches; theorem path in lib/pipeline); admitted by lib/quota (429 with the reason), run as a job (queue, cancel on disconnect → 499)
    solve-stream/route.ts           # Same as SSE: first frame {type:"job", job_id, session_id}, progress frames (stage "queued" carries `position`), then result / error / {type:"cancelled"}
    solve-compute/route.ts          # Standalone computational solver
    solve-geometry/route.ts         # Geometry solver (Clingo ASP)
    verify/route.ts                 # Final Lean verification

lib/
  types.ts                          # All domain types + constants (TAXONOMY, MATH_DOMAINS, etc.)
  schemas.ts                        # Zod schemas for all LLM outputs
  auth.ts                           # NextAuth configuration (JWT, providers, callbacks); signIn callback = invite list (lib/access.ts), refused → /auth/signin?error=AccessDenied
  access.ts                         # Invite-only beta: authRequired() (AUTH_REQUIRED, default on in production), invite list (INVITE_EMAILS / INVITE_DOMAINS / INVITE_FILE, default .data/invites.txt, re-read on every sign-in; closed when required and empty), requestOwner() (signed-in user id; "local" only when auth is not required; else UnauthorizedError → 401 via withRequestLocale / bankRoute)
  model-route.ts                    # modelRoute(handler): every API route that calls a model — caller known (401), admitCall (today's spend limit, RATE_LIMIT_CALLS_PER_MIN) → 429, calls charged to the caller as they happen (withOwnerBilling); bank routes use bankRoute(…, { model: true })
  startup-checks.ts                 # When auth is required: fatal (server refuses to start, instrumentation.ts; STARTUP_CHECKS=warn overrides) = no NEXTAUTH_SECRET / sign-in provider / LLM key / a model without an LLM_PRICES price; warnings = no invite list, no QUOTA_DAILY_USD_FREE, Stripe key without webhook secret
  db.ts                             # Prisma client singleton: client generated into lib/generated/prisma (git-ignored; `npx prisma generate`, also run by postinstall) + better-sqlite3 driver adapter
  db-url.ts                         # SQLite URL for prisma.config.ts and the adapter: relative file: paths resolve against prisma/ (Prisma 5 behaviour) → prisma/.data/prod.db
  session-store.ts                  # Sessions: in-memory cache + SQLite (default, SQLITE_DB_PATH; the JSON files are imported the first time the table is empty) or JSON files (SESSION_BACKEND=json); `owner` column, list/search per owner
  session-access.ts                 # getSessionForRequest / createSessionForRequest: API routes see only the caller's sessions (someone else's = not found; sessions without owner = "local")
  jobs.ts                           # Solve jobs: SOLVE_CONCURRENCY running (default 2), the rest queued in order with their place; per-user limit (plan's concurrentSolvers, else JOBS_PER_USER); cancel by owner (POST /api/jobs/:id/cancel) or when the client goes away; the cancel signal travels in AsyncLocalStorage — the LLM client refuses new calls and aborts the one in flight (no retry/fallback), verifyLeanSource refuses to start, the theorem pipeline stops at stage boundaries (CancelledError)
  quota.ts                          # admitCall (other model routes: daily spend + RATE_LIMIT_CALLS_PER_MIN) and withOwnerBilling (usage-tracker billing: every call charged as it happens, streaming included; billingCapReached stops new calls past today's remaining budget). Per-user limits: plan from the active subscription (else free) — proofsPerMonth solves a month, concurrentSolvers at once; optional daily spend QUOTA_DAILY_USD_<PLAN> (what is left caps the run's cost with PROOF_COST_CAP_USD); RATE_LIMIT_PER_MIN starts a minute (default 6); usage in QUOTA_DB_PATH (default .data/usage.db); the local single user is unlimited unless QUOTA_LOCAL_PLAN
  utils.ts                          # cn() utility (clsx + tailwind-merge)
  math-segments.ts                  # Math text segmenter ($, $$, \(, \[)
  markdown-table.ts                 # Markdown tables in question text (scans keep tables that way): split/parse/remove; MathText renders them as tables (span-based, valid inside <p>)
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
    expr.ts                         # Safe expression compiler for function plots (no eval); compileExprVars adds one-letter variables (slider parameters, table columns)
    generate.ts                     # LLM → FigureSpec → solve/check → one repair round; keyword pre-filter
    logic.ts                        # Logic-puzzle diagrams: grid (matching), Venn (2–3 sets), ordering (row/circle), tree — exhaustive solve, uniqueness + answer checks
    logic-render.ts                 # SVG for logic diagrams (✓/✗ grid, Venn regions, seats, tree + leaf list)
    strategy.ts                     # Solution-strategy figures (FigureSpec.strategy), solved and checked by the program: bar_model 线段图 (parts in equal units or given values; the value of one unit is found from what is given, every number checked against it, sum/difference relations between bars, the asked part/bar checked against the answer), number_line (points, jumps with checked size, spans), prob_tree (exact fractions: forks add up to 1, leaf = product, asked event = sum of its leaves vs the answer), enum_table 列表法 (one or two variables tried over a range, derived columns, conditions with one comparison; rows that fit are marked; count / the one solution checked), graph_explore (functions of x and a slider parameter, a point that follows the slider, live read-outs; claimed max/min and intersections checked by sampling). Elements carry from_step (appear at that solution step) and unknowns reveal_step ("?" until then); strategySteps lists the steps that change the picture
    strategy-render.ts              # SVG for strategy figures (dark theme), honouring step (build-up), highlight and the slider value; graphReadouts
    solid3d.ts                      # 3D figures: cube_stack (column heights seen from above + caps on columns — half_cylinder/roof/pyramid/cylinder/cone/dome as convex meshes — → oblique/isometric drawing with painter's order, unit cubes or plain blocks (unit_lines: false, seams merged); front/left/right/side/top views computed from the same data (depth-step edges, cap outlines) or blank grids; show_stack false = plans only; hidden-cube note) and solid (convex polyhedra with face-normal visibility and dashed hidden edges; cylinder/cone/sphere/hemisphere; edge labels)
    star.ts                         # Star shapes cut into identical pieces: n points + tip angle → star, division to tips (concave quadrilaterals) or inner corners (kites), one piece beside it, symmetry lines, angle labels; starAngles/allStarAngles give every exact angle
    speech.ts                       # Someone saying something: simple generic child figure(s) with a speech bubble beside the head (laid out so nothing covers anything), CJK/word wrapping, optional answer choices with empty circles
    tiles.ts                        # Equal tiles side by side in a row (equilateral triangles alternating up/down, squares, hexagons): first tiles shaded/dashed, dashed lines for a row that goes on, side label; outsideSides (n+2 / 2n+2 / 4n+2) and rowShape (odd triangles → trapezium, even → parallelogram)
    reflection.ts                   # Reflection figures: mode two_lines (shape top-left, dashed lines l/m, empty target boxes, numbered cards each the shape after a transform; reflectionAnswer gives the right card per box) and mode one_line (shape + one dashed mirror line, the cards are answer choices A–D in a 2×2 grid; mirrorChoiceAnswer gives the right choice). Squares may be half shaded along a diagonal ([r, c, "tl"|"tr"|"bl"|"br"]); transforms flip/turn the shading too, "flip_h_squares"/"flip_v_squares" move the squares but keep the shading (the usual wrong choice); symmetric shapes and look-alike cards are reported
    street.ts                       # Things standing in a row along a street (house, tree, shop, school, flats, bush, lamp, car, flower pot): simple generic drawings on grass and a road, named colours (walls cycle blue/yellow/pink/purple/… when not given), optional label under each; description lists them left to right and says when nothing is labelled (ordering questions keep the houses unlabelled)
    svg-overlap.ts                  # Overlap finder for model-drawn SVGs (bounding boxes, absolute coordinates, no transforms): a filled shape over text or over most of an earlier smaller shape
    visual.ts                       # Figures for generated questions: VisualSpec (clock, number_line, bar_chart, pictograph, table, grid_shape, fraction, groups, geometry, cube_stack, solid, star, speech, tile_row, reflection, street, cards layout (cards may carry a simple icon and a checkbox), group = several figure areas (a part may be model-drawn svg — the whole figure then counts as model-drawn); specNodes walks every part; "svg" = model-drawn fallback) → program-drawn SVG in a FigureStyle (colour/accent/fill/font/stroke/frame from the template) + exact text description; sanitizeSvg; VISUAL_GUIDE for prompts
  bank/                             # Customer question banks (试题库), stored per account under .data/banks/<owner>/<bank>/
    types.ts                        # Zod types: Bank, Item, Category (manual | filter | style template), ImportBatch/DraftItem, TemplateProfile, Generation/Candidate
    store.ts                        # Storage: one SQLite file per bank (better-sqlite3), JSONL fallback; owner isolation; BankError
    similarity.ts                   # Stem normalisation, fingerprints, BM25 near-duplicate search
    query.ts                        # Item filters, category membership
    vocab.ts                        # Built-in knowledge-point vocabularies (Australian Curriculum, 课标) + bank's own
    import/                         # Importers → draft batch: pdf.ts (unpdf text + question splitter + optional model tidy with verbatim check), tabular.ts (CSV/Excel column mapping), text.ts (Markdown/TXT), fields.ts, checks.ts (duplicates, missing fields)
                                    #   ocr.ts — scans/photos: page image → vision model (role "vision"): survey → verbatim transcription (LaTeX maths, figure boxes with kind + what they show) → per-question template analysis (template_hint) → same splitter; figures cropped and attached with descriptive captions, source.page_image kept, every draft needs review
                                    #   "使用此题" on a bank item carries its figures: /?problem=…&bank=<id>&fig=<asset>… → shown under the problem (UsedProblemFigure.images); a generated candidate on the bank page (figure not yet an asset) always links as /?problem=…&bank&gen&cand and the page loads the figure from the generation (candidateHref)
                                    #   images.ts — image detection (HEIC refused), sharp loaded at run time if present (orient/scale/crop), scanned-PDF page scans from embedded images (unpdf extractImages; `pages` selects pages; a vector-drawn page is rendered when @napi-rs/canvas is installed, else listed as skipped with a note), JS PNG encoder/scale/crop fallback
                                    #   PDFs are judged page by page: a file that is almost all scan is read entirely by the vision model; a paper whose questions are page images (online-test screenshots) next to a few text pages (cover, results) has those picture pages read by the vision model, and only numbered questions are kept from its text pages. Pages are read by a pool (BANK_OCR_CONCURRENCY, default 5)
                                    #   answer-key.ts — answer keys on text pages (columns as pdf.js extracts them: 1…N, N answers, N categories; rows "12  C  Number & Arithmetic …"; inline "1.C 2.B …"): kept out of the questions, answers filled in by question number (letters, or a value mapped to its option), disagreements reported on the draft, the printed category added as a tag
    classify.ts                     # Model classification: catalogue path (2 levels, reuses existing categories), grade, knowledge points (snapped to vocab), difficulty 1–5; runs on import and via reclassify.ts (/api/banks/:id/classify); every question is decided on its own (a file mixes topics), by the mathematics done rather than the objects pictured, with the paper's printed category (answer-key tag), figure captions and template note as evidence; names keep leading digits ("2D shapes", only numbering is stripped); near-duplicate names (case, plural, "&"/"and", bracketed part) snap to existing categories and are unified across the chunks of one run (unifyNewPaths). The import's commit step lists how the questions spread over categories; "also put the batch in one group" is an extra, optional category
    profile.ts                      # Template profile of a class (programmatic + model summary), exemplar selection
    generate.ts                     # Same-type generation (同类创编) from a category, picked items or style template; checks: format, independent answer, novelty vs bank, fit
    select.ts                       # Template selection by level/difficulty/topic (category incl. sub-categories, or knowledge point); widens difficulty ±1 → any → level any, never the topic; generator pickers (template-options)
    generator-bridge.ts             # /api/generate-problem source "bank": generation from a selection → GeneratedProblem cards with bank meta (checks, generation id); 2–MAX_TEMPLATE_RUNS matching questions → one generation per question (template ref `selection` + `item_ids: [id]`, progress prefixed "模板 i/n", a failed template noted and the rest kept; result `templates`, `generation_ids`, `requested` = count × templates; "导出 PDF" then hands all questions over in localStorage); passes `onProgress` through, returns `requested`, leaves the "N requested, M passed" sentence out of the note
    ordering-check.ts               # "Who lives where, from left to right?" questions: distance and left/right clues read from the stem ("A and B each live N paces from C", "N paces to the left of", "to the right of", "apart"), every order that fits found by placing people along a line; exactly one must fit and be the answer (mirror images told apart by a street figure's uneven gaps, e.g. the tree between two houses); contradictory clues fail; an unread clue with several fitting orders leaves it to the solver
    generation-view.ts              # Browser-side: card status (ok / review / failed), inline check issues, NDJSON reader
    template-runs.ts                # Browser-side: generation runs for the bank page's template — one per category, one per selected question (MAX_TEMPLATE_RUNS 10)
    worksheet.ts                    # Browser-side: worksheet questions from candidates, answer text ("C. 12"), option columns, localStorage hand-over to /print, print URL for a generation
    http.ts                         # bankRoute(): owner from NextAuth session (else "local"), request language, error mapping
    template-visual.ts              # Template figures (scans/photos: item images or page image) read by the vision model before generation: per-example figure description + kind, style (FigureStyle), layout; never imitates illustrations/logos
    problem-figures.ts              # Figures sent with a problem (bank images, `figures: [{bank_id, asset}]` on /api/solve-stream, /api/solve, /api/enumerate): read once by the vision model into a description appended to problem_text (session.figure_description); failures fall back to text-only with a note
  pipeline/
    theorem-pipeline.ts             # Theorem pipeline shared by /api/solve and /api/solve-stream
    lean-attempt.ts                 # Lean formalization attempt for non-theorem problems; solves skip it unless `options.lean_attempt: true` (the UI starts it from the Lean tab). The known answer goes into the formalization; an accepted statement is proved (hammer → single tactics → whole-proof loop with the NL solution as sketch, PROOF_BUDGET default low); a failure lists what was tried and where the closest proof failed; a failed attempt can be run again ("再试一次"); when the statement with the first answer fails any check and solving produced another answer, that one is formalized next; a statement with a power too big to compute skips the automation, the prover gets the p-adic / lifting-the-exponent lemmas (padicValNat_dvd_iff_le, padicValNat.pow_sub_pow, padicValNat.pow_two_sub_one, padicValNat.pow) and the failure says why; divisibility "find all n" statements get the bound-then-check recipe (a ∣ f n → a ∣ constant via Nat.dvd_add_right, Nat.le_of_dvd, interval_cases); coordinate-geometry statements (ℝ × ℝ) get componentwise proof advice, and a heartbeat timeout is explained as "ran out of Lean's computation budget" rather than shown raw
  prover/
    whole-proof.ts                  # Whole-proof loop: sample k proofs → verify → repair with feedback + suggestions; each candidate records `progress` (tactic lines before the first error); earlyStop (PROOF_EARLY_STOP) gives up after round 0 when no candidate got past its first tactic (gaveUpEarly); stops when the run's cost cap is reached (costCapped); a native prover (proverPromptStyle) gets nativeProverPrompt (no system message, plan first, LLM_PROVER_MAX_TOKENS/TIMEOUT_MS) and a self-correction turn (its proof as the assistant turn + Lean's errors); extractTactics(text, theoremName) takes the target declaration when the answer also defines helper lemmas (logged, not carried over)
    sketch.ts                       # Sketch-and-fill: numbered informal proof first (planner role, high effort; SKETCH_INFORMAL, skipped when the caller gives a hint) → skeleton with one `have … := by sorry` per step → each hole: hammer, then the whole-proof prover on the hole as a lemma of its own (goal-statement.ts; checked to elaborate first; SKETCH_HOLE_PROVER auto = when LLM_PROVER_MODEL is set), then goal search → splice → strict verify
    budget.ts                       # PROOF_BUDGET presets (low/normal/high) for whole-proof, sketch and goal search; `sketchStage` false on low (sketch-and-fill proved nothing on the miniF2F baselines); SKETCH_ENABLED=true forces it on
    context.ts                      # Prover context: retrieved premises + recalled proofs as one prompt block; rememberVerifiedProof (source, opens)
    replay.ts                       # Memory replay (plan 7b P3): recalled proofs of similar theorems tried verbatim before any model call (≤ 3 Lean checks, scripts ≤ 40 lines, full verification incl. statement lock); PROOF_MEMORY_REPLAY=false turns it off; theorem pipeline stage "memory" (strategy "memory"), bench cascade proved_by "memory"
    dataset.ts                      # Expert iteration data: harvestRows (bench result rows → proofs to remember), sftRecords / repairRecords (native prover chat format, stable hash train/eval split, benchmark test sets left out unless includeTest), tacticNames / jaccard, memoryHitStats (leave-one-out similar-theorem hit rate)
  llm/
    client.ts                       # Core LLM client (roles, sampling, retry, fallback, cache, Zod); extractJson runs fixLatexEscapes first: LaTeX written with one backslash inside JSON strings (\frac, \times, \neq, \angle) is kept instead of turning into a form feed / tab / newline or a parse error
    output-locale.ts                # Output language per request (ui_locale cookie): prompt switch for English, lt(zh, en), withRequestLocale
    config.ts                       # LLM config from env vars (role chains, prices); proverPromptStyle (LLM_PROVER_PROMPT auto|native|chat — auto = native when the prover model name contains "prover"), nativeProverSettings, chatProverRole (sketch + goal-search use the general chain when the prover is native)
    cache.ts                        # LRU response cache (SHA-256 keyed)
    logger.ts                       # Structured JSON logger
    usage-tracker.ts                # Usage records + per-run scope (RunMetrics); per-scope cost cap (withUsageScope opts.costCapUsd, default PROOF_COST_CAP_USD): costCapReached() once the scope's estimated cost (LLM_PRICES) reaches it — the client then refuses new calls (CostCapError), the prover stages stop and the theorem pipeline returns before the stepwise search (cost_capped)
    prompts.ts                      # Prompts (enumerate/plan/prove-step/whole-proof, Lean 4 pitfalls)
    agent-prompt.ts                 # Agent system prompts (6 roles + 10 domains)
    autoformalize.ts                # Autoformalization: candidate voting (AUTOFORMALIZE_CANDIDATES) + 6 validation layers (elaborate, refute, non-trivial, back-translate, numeric, relevance); the non-trivial layer judges the statement against the original problem text (a faithful statement of an easy problem such as n + 0 = n passes; only a formalization that became easier than the problem fails; the relevance layer (L5) judges hypotheses against the original problem too: an assumption the problem neither states nor implies, or a contradiction, fails; a redundant hypothesis that follows from the data (a 13-14-15 triangle also stated as acute) is reported, not failed; a figure fixed up to congruence by its data may be placed in WLOG coordinates (B = (0,0), C = (15,0), A = (33/5, 56/5)) — the formalizer is told to, and L2 accepts it as the problem itself)
    classify-problem.ts             # Problem type classifier (counting what a drawing contains is computational even when it says "maximum")
    enumerate.ts                    # Method enumeration
    equation-setup.ts               # Equation extraction from word problems (target_expression: a list from the model becomes one SymPy tuple "(x, y)", one item is taken as is)
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
    parse-log.ts                    # Lean error parser (8 error kinds); timeouts first; Lean 4 wording (backtick-quoted names, "omega could not prove", "failed to prove positivity", "made no progress", "Function expected")
    sandbox.ts                      # verifyLeanSource: sanitize → REPL/spawn → verdict (sorry, axioms, statement lock); autoImplicit off prelude
    repl.ts                         # leanprover-community/repl client: worker pool, header env reuse, tactic mode, timeouts
    proof-state.ts                  # ProofSession: pinned REPL worker, goal states as handles, apply tactic, replay on worker loss
    hammer.ts                       # Automation cascade (skipped when the statement has a power too big to compute — hugePower; rfl/decide/`decide +kernel` on closed goals — big-number facts such as gcd(2^2024+1, 2^3036-1) = 1, which the elaborator refuses above exponent 256/simp/omega/norm_num/linarith/nlinarith hints/positivity/aesop/exact?)
    premises.ts                     # Premise retrieval: BM25 over Mathlib names/statements (built index + curated seed), similar-name hints; RENAMED_LEMMAS (old Mathlib names models still write → current name, e.g. Real.sqrt_eq_iff_sq_eq → Real.sqrt_eq_iff_eq_sq, Set.mem_setOf_eq → Set.mem_ofPred_eq) answered first
    premise-seed.ts                 # ~700 curated Mathlib lemmas used when no index is built (names checked against the sandbox's Mathlib v4.33.1 sources; a test keeps renamed names out)
    proof-memory.ts                 # Verified proofs stored in .data/proof-memory.json (PROOF_MEMORY_MAX default 10000; each with source "solve" / "bench:<file>" and opens); similar proofs recalled as worked examples (recallScored: with BM25 scores, `touch: false` / `among` for evaluation); rememberProofs (bulk, one write); replay hits counted per entry; repair pairs (failed proof + Lean feedback → fixed proof) appended to .data/proof-repairs.jsonl (PROOF_REPAIRS_PATH)
    refute.ts                       # Counterexample search for statements: `decide` on the negation, Mathlib `plausible`
    sanitize.ts                     # Forbidden-command filter (#eval, elab, unsafe, axiom, …) + statement validation
    axioms.ts                       # `#print axioms` / `#check` parsing, standard-axiom allowlist
    trivial-proof.ts                # Single-tactic proof attempts (with full verification)
    goal-statement.ts               # A printed goal state → lemma statement (hypotheses as binders with the same names, inaccessible names renamed, instances as [..], universes as Type*), for proving a sketch hole on its own
    statement-prop.ts               # Binder-form theorem type → one proposition (∀ binders, goal); top-level colon split
    modernize.ts                    # Rewrites removed/Lean 3 syntax in model output (∑ x in s → ∑ x ∈ s, cases … with x → cases', λ x, e)
    feedback.ts                     # Verification result → proof-relative feedback for the model; summarizeFailure adds the remaining ⊢ goal to "unsolved goals"
    suggest.ts                      # exact?/apply?/simp? probes at the failing goal ("Try this" parsing)
    loogle.ts                       # Optional Loogle client (LOOGLE_URL) for unknown identifiers; unknownIdentifiers reads Lean 4's "Unknown constant `X`" (backticks) as well as the old '…' quoting
    sorry-gate.ts                   # Sorry labeling + verification report
  agents/
    orchestrator.ts                 # Multi-agent orchestration (parallel fan-out)
    strategist.ts                   # Domain-specialist strategist agents
  compute/
    engine.ts                       # Compute engine facade (SymPy bridge + fallback)
    solver.ts                       # Computational solver pipeline: SymPy methods or the model fallback, then exact program checks (order-check: the program's answer wins and a corrected model answer is reported in `checks`), then the explanation; when the explanation ends with a different \boxed answer and nothing settled it, a high-effort re-check decides (also reported in `checks`, shown as progress lines)
    order-check.ts                  # "Smallest positive n with a^n ≡ 1 (mod m), …": congruences read from LaTeX/plain text, multiplicative orders via Carmichael λ, answer = lcm (a model once answered 1814400 for 907200)
    nat-expr.ts                     # Closed natural-number expressions (+ − × ^, parentheses) → BigInt; used by order-check and the Lean attempt's range-size estimate; natExprLog2 / hugePower: a power whose exponent is above 2^24 (Lean refuses it: "Nat.pow exponent is too big"), e.g. 2025 ^ (2024 ^ 2024)
    cross-validate.ts               # Result cross-validation (tolerance clustering)
    reconcile.ts                    # Program answer vs the written solution's \boxed answer (optimization handlers): a disagreement is re-checked (resolveConflict), reported in `checks` and no longer cross-validated; the solution is rewritten when it argues for the losing answer (a "how many triangles in the drawing" question was once extracted as "2 positive integers summing to 3" → 2, the solution counted 18)
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
  bench.ts                          # Prover benchmark: cascade/whole_proof/sketch/stepwise, budgets, proved-by + failure taxonomy; --cost-cap usd per theorem (default PROOF_COST_CAP_USD; failure budget_exhausted, row cost_capped), --early-stop (row early_stop; later stages skipped), --no-retrieval; in the cascade sketch-and-fill runs on hard theorems only (SKETCH_HARD_ONLY=false: all); --concurrency n (runPool; LEAN_REPL_WORKERS defaults to n), --max-cost usd (no new theorems once spent; the rest listed as skipped), --memory readonly (default: recall but do not store, so runs do not feed later runs) | write (also repair pairs) | off (no recall, no replay — compare with runs made before the memory was filled; the result JSON records memory_size); the cascade replays recalled proofs after the hammer (proved_by "memory"); environment failures (`infra_error`: model call failed, a Lean worker hung on the statement check) are retried once at the end (--no-retry); statements are repaired on load (fixStatement); result JSON records concurrency, memory, commit, models, elapsed time
  bench-ablation.ts                  # `npm run bench:ablation`: the benchmark once per variant (base, no_retrieval, seed_premises, whole_proof, early_stop, sketch, normal, cost_cap) on the same deterministic sample of miniF2F theorems (every k-th per difficulty, --sample 60) → bench/ABLATION.md: proved, cost, cost per proof, gained/lost vs base, marginal theorems per dollar
  bench-formalize.ts                # `npm run bench:formalize`: miniF2F informal statements → autoformalize → compared with the official Lean statement (same signature / hammer proves official ↔ ours / not shown / refuted) → bench/FORMALIZATION.md: faithful share, acceptance, layers too strict or too loose, failed layers, cost
  bench-report.ts                   # Result JSON files → Markdown (bench/BASELINE.md): one row per run, proved-by / failures / cost of failures per run, gained and lost theorems between consecutive runs
  bench-baseline.ts                 # `npm run bench:baseline`: retest the first 20 miniF2F theorems (normal budget), then all 244 (low budget, --max-cost 12), 3 at a time, then BASELINE.md from every miniF2F result; `--rerun <full.json>` re-runs only the theorems a fix touched and merges them; `--prover <merged.json>` tries the configured prover on that run's failures (bench --only-failed) and merges into "<full>-prover.json"; runs under `caffeinate -i` on macOS
  proofs-harvest.ts                 # `npm run proofs:harvest -- bench/results/*.json`: every proof a bench run verified into the proof memory (statements from the bench file, repaired as on load; source bench:<file>; --dry-run)
  proofs-export.ts                  # `npm run proofs:export`: data/proof-dataset/ — proofs.jsonl, sft-train/eval.jsonl, repair-train/eval.jsonl, README.md (counts; miniF2F-test proofs left out of training unless --include-test)
  proofs-eval.ts                    # `npm run proofs:eval [--replay]`: memory size and leave-one-out hit rate (top-k recalled proofs use the same tactics), optionally verbatim replay in Lean → bench/MEMORY.md
  prover-check.ts                   # `npm run prover:check`: one call to the prover endpoint (model/host, prompt style, latency, tokens/s, cost, proof read back, verified when Lean is available)
  bench-merge.ts                    # Re-run rows replace the full run's rows by id, totals recomputed, Lean-message failure buckets re-classified; rerunIds (statements fixStatement changes + environment failures)
  fetch-benchmark.ts                # miniF2F (Lean 4) → bench file (`npm run bench:fetch`); fixStatement: big-operator bodies with a top-level +/- are parenthesised (the body is now parsed at precedence 67, so `∑ k ∈ s, a + k * d` lost k), Complex.abs z → ‖z‖
  migrate.mjs                       # prisma/migrations/*/migration.sql → SQLite (DATABASE_URL), recorded in _app_migrations; adopts a db-push database; runs at container start (no Prisma CLI in the image)
  backup.sh                         # Consistent snapshot of the app-data volume (SQLite online backup + files) → backups/app-data-<time>.tar.gz
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
  schema.prisma                     # Database schema (User, Subscription, ProofSession); generator `prisma-client`, no datasource url (Prisma 7)
  migrations/0001_init/             # Initial SQL (what `prisma migrate diff --from-empty` writes); add a numbered folder per schema change
prisma.config.ts                    # Prisma 7 CLI config: schema path, datasource URL (loads .env.local / .env itself)

docs/
  P3-FEATURES.md                    # P3 features setup and usage guide

lean-sandbox/
  LeanSandbox.lean                  # Library root (imports Mathlib + Batteries + Aesop)
  lakefile.toml                     # Lake build config (mathlib v4.33.1 + repl v4.33.0 dependency)

proxy.ts                            # Next 16 proxy (ex-middleware): when auth is required, pages redirect to /auth/signin and API calls get 401 without a session token (public: /auth, /api/auth, /api/payments/webhook, /api/health)
instrumentation.ts                  # Server start: on the Node runtime imports instrumentation-node.ts (lib/startup-checks.ts; process.exit on a fatal problem — kept out of this file, which Next also compiles for the Edge runtime)
Dockerfile                          # Debian images: Lean stage (elan + Mathlib cache + `lake build repl`), Next standalone runner with /opt/elan + built lean-sandbox; CMD = scripts/migrate.mjs then server.js; HEALTHCHECK /api/health
Dockerfile.compute                  # Python compute server
docker-compose.yml                  # Invite-only beta: env_file .env.production (template .env.production.example), AUTH_REQUIRED=true, state on the app-data volume; only nginx publishes ports; neo4j optional (--profile knowledge)
nginx.conf                          # 80 → https redirect (+ ACME), 443 TLS (certs/), /api/ unbuffered with 30-min timeouts (SSE/NDJSON progress, cancel on close), rate limits
docs/BETA-DEPLOY.md                 # Invite-only beta deployment guide (Chinese)
.dockerignore                       # Docker build exclusions

tests/                              # 116 Vitest test files (unit + fake REPL + real-Lean integration)
components/ui/                      # 16 shadcn/ui primitives (+avatar, dropdown-menu, label)
```

## Key Patterns

- **All LLM outputs validated by Zod** — one resample on invalid JSON, then throw
- **Whole-proof first**: the prover role samples complete proofs (`sampleText`, temperature 0.8, no cache) which are verified in parallel; the best failure is repaired with positioned errors / open goals (`lib/lean/feedback.ts`) plus `exact?`/`apply?`/`simp?` suggestions (`lib/lean/suggest.ts`); the statement is always re-assembled from the validated declaration
- **Repair loop**: generate Lean code → compile → classify error → feed back → retry (max 3); the prover is given the Lean goal state (from the verifier's sorry goals) for the step it is working on; the stepwise search samples k candidates per step, verifies them in parallel and branches on distinct goal states (beam-bounded)
- **REPL tactic mode**: `ProofSession` opens `theorem … := by sorry` once and applies tactics to goal-state handles (milliseconds per step, replayed if the worker dies); the hammer, goal-level search and sketch-and-fill all run on it. Every result is still re-assembled as text and passed through `verifyLeanSource`
- **Budget-aware LLM calls**: `expectedLatencyMs(role)` (EMA of observed call latencies, timeouts included) gates every repair round, goal-search expansion and sketch round — a call that cannot finish in the remaining budget is skipped rather than aborted (aborted calls still bill their tokens); tactic-step calls use `reasoningEffort: "low"` on reasoning models
- **Retrieval before generation**: `buildProverContext` (premises for the initial goal + verified proofs of similar theorems) feeds the whole-proof, sketch and goal-search prompts; goal search re-retrieves per node; unknown identifiers get "similar declarations" from the local index
- **Strategy figures**: for word problems, probability, trial-and-error tables and function extremes the figure model writes `strategy` (bar model, number line, probability tree, enumeration table, graph with a slider) instead of geometry; the program solves and checks it like the other figures (a failed check goes back to the model once). The picture builds up with the solution steps (from_step / reveal_step), the step cards and the figure share the highlight colour, and the slider lets the student move a parameter
- **Figures are computed, not drawn by the model**: the model writes a `FigureSpec` (what to construct and which conditions hold); `lib/figure` computes coordinates, checks every condition numerically and renders SVG. A figure whose conditions fail is shown as a sketch ("示意图"), never as accurate; figure checks are separate from Lean verification. Logic puzzles use `FigureSpec.logic` (grid/venn/ordering/tree): the program solves the puzzle exhaustively and checks uniqueness and the stated answer
- **Question banks**: imports never go straight in — every file becomes a draft batch that is reviewed (with a rights confirmation) before commit; the model only restructures PDF text and anything it rewrites is rejected in favour of the original. Scans and photos are transcribed by the vision model; nothing read from an image is trusted — every such draft is marked for review and shown next to its page image. Generated questions are candidates with four checks (format, independent re-solve, novelty vs the bank, fit) and enter the bank only when adopted by hand, marked origin "generated". On import the model decides each question's catalogue place, grade, knowledge points and difficulty (`classified: {by: "model"}`); values present in the file are kept, everything stays editable in review, and missing categories are created on commit
- **Formalization reliability**: several sampled statements vote by elaborated signature (α-normalised); the winner must survive `decide`/`plausible` counterexample search (layer 6) before any LLM validation layer or proof search is spent on it
- **Roles + metrics**: `chatJson`/`sampleText` take `role: "prover" | "planner"`; endpoint chains come from `LLM_PROVER_*` / `LLM_PLANNER_*`; every solve runs in `withUsageScope`, and `verifyLeanSource` records itself, so responses/sessions carry `metrics` (calls, tokens, cost, verifications, wall time)
- **Sorry degradation**: unprovable steps get `sorry` annotations, pipeline continues
- **Trusted verification**: every source is sanitized (no `#eval`/`elab`/`unsafe`/`axiom`…); a complete proof counts only if Lean reports no errors, no `sorry` (textually AND via `#print axioms` — catches `admit`), only `propext`/`Classical.choice`/`Quot.sound`, and the proved statement's `#check` signature equals the one recorded when autoformalization was accepted (statement lock — the planner cannot change the theorem)
- **Generated figures**: when template questions have images, generation reads them with the vision model (descriptions + style), the writer returns a figure spec per question, the program draws it in the template's style, and the re-solve/judge see `[Figure: exact description]`; a 5th check `figure` (program-drawn & geometry conditions hold; model-drawn SVG re-read by the vision model, else skipped); adopting saves the figure (PNG via sharp, else SVG) as the item's image; "使用此题" sends the description as `figure_text`. Tables: when most template questions have a table (Markdown in the stem, or a table the vision model saw), every new question must have one — the prompt asks for a `table` figure, a Markdown table the writer puts in the stem is moved into a drawn table, and the figure check fails a question without a table; drawn tables show blank/"?" cells as boxes to fill in. 3D: when the template's figures are 3D (vision kinds `cube_stack`/`solid`, or import captions starting with them), every new question must have a 3D figure — the prompt asks for it and the figure check fails a question without one; the scan-reading prompt describes block figures (cube stacks, steps, buildings, plans) as column heights seen from above (back row first) plus caps, and solids with their edge labels; "plans → which 3D drawing" questions are cards: a views-only cube_stack, then one cube_stack per option. "Select all" questions (stem says select/tick all…, 选出所有…): multiple choice whose answer is a letter set ("A, D") — kept whole, format-checked and compared as a set; when the stem gives a total ("exactly $5") and every option's price is found (figure cards/table rows or stem lines), `selectionCheck` enumerates every subset: exactly one must make the total and it must be the answer. Tables are required from the figures only when most template figures are tables; otherwise the writer is told to keep the template's kind. Templates whose questions have several images (figure areas) get `areas` in the plan and the writer is told to draw a `group` with one part per area (answer choices as 1-column checkbox cards). Stems too close to a bank question (≥ TOO_CLOSE) are reworded once before the checks (`rewordTooClose`: same numbers — checked — same select-all form, must end up less similar). `tileRowCheck`: with a tile_row figure, the perimeter in the stem must equal outside sides × side length for the answer's tile count (or the reverse), and "trapezium"/"parallelogram" must match the parity. `reflectionCheck`: with a reflection figure, the answer (free text or option) must name the card for the first image and for the final image (places: top-right/bottom-left, bottom-right — or the order named); the shape must not be symmetric and no two cards may look the same; one_line mode: exactly one choice is the flipped shape, the options are the pictures in order and the answer letter must be that choice. `answerLeak`: a figure must not show the answer — an ordered answer ("Eva, Nora, Omar, Liam") whose items the figure already shows in that order (number-line labels by value, or the description read in order) while no other option's order is shown fails the figure check and goes to the figure-repair round; the writer, figure-fix and fit-judge prompts say the same. `orderingCheck` (lib/bank/ordering-check.ts) settles left-to-right ordering questions with distance clues — the model solver once agreed with a question whose clues contradicted each other. Program checks also settle free-text ("other") answers. The fit judge scores type and layout only (answers are checked by the solver and the program). Model aliases such as geometry op `equilateral_triangle` are mapped before validation (`normaliseSpec`). When the repair or rewording round does not help, the figure / novelty check says what happened (no new figure, still unusable, number changed, not less similar). Rounds: while fewer than the requested number pass, generation writes again (at most `MAX_ROUNDS` = 3 rounds), giving the writer the earlier questions and why they failed; earlier rounds count for the novelty check; a short result is explained in the generation note. Each generation stores `figure_plan` (kinds per example, layout, tables, 3D) for diagnosis. Figure repair: a spec the program cannot use (the error names the value the model wrote) or a missing required table/3D figure goes back to the writer once (`repairFigures`) before the checks; then a model-drawn SVG that `svgOverlaps` finds covering itself (no vision call) or the vision model rejects (its prompt also fails covering, cut-off or overflowing drawings), or a program figure whose angles contradict the question (`angleCheck`: degree values in the stem/answer must be angles the figure has, e.g. star pieces), gets one more round, and redrawn SVGs are re-checked. Template notes: reading a scan, the vision model follows a 3-step prompt (survey regions/reading order/decoration → verbatim transcription with careful clock/scale/tally reading → per-question analysis: task, template_note, and exactly what each figure shows); this becomes the question's `template_hint` (editable in review and in the item editor) and the figure captions; when those questions are templates the distinct notes (≤ 3) go to the template-visual call, the writer and the fit reviewer (not to the independent solver)
- **Problem figures**: the solving pipeline is text-only; a bank question's figures are read once by the vision model (stage `reading_figure`) and the description is appended to the problem text, so every later step (classification, equation setup, NL solution, autoformalization, provers) has it; the UI shows what was read
- **4 problem types**: computational | theorem | optimization | find_all_values
- **Dual solve paths**: `/api/solve` classifies and dispatches; individual endpoints for step-by-step control
- **Dark theme UI**: Chinese-first, LaTeX via KaTeX, warm academic color palette

## Environment Variables

See `.env.example`:
- `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` — LLM configuration
- `LLM_FALLBACK_*` — Fallback model configuration
- `LLM_PROVER_*` (incl. `LLM_PROVER_STEPWISE`), `LLM_PLANNER_*`, `LLM_VISION_*`, `LLM_PRICES` — role endpoints and cost table (vision: reads scans/photos imported into banks; `BANK_OCR_MAX_PAGES` caps pages read per import, default 30; `BANK_OCR_CONCURRENCY` pages read at once, default 5)
- `LLM_REASONING_EFFORT`, `LLM_<ROLE>_REASONING_EFFORT`, `LLM_REASONING_TOKEN_BUDGET`, `LLM_SAMPLING_PARAMS`, `LLM_MAX_TOKENS_PARAM`, `LLM_REASONING_PARAM` — OpenAI reasoning-model dialect (GPT-5.x/GPT-6/o-series auto-detected: no temperature/top_p, `max_completion_tokens`, `reasoning_effort`; on openrouter.ai `max_tokens` + `reasoning: { effort }`)
- `WHOLE_PROOF_*`, `LEAN_SUGGEST_TIMEOUT_MS`, `LOOGLE_URL` — whole-proof loop, library search
- `PROOF_BUDGET`, `LEAN_TACTIC_TIMEOUT_MS`, `LEAN_HAMMER_BUDGET_MS`, `GOAL_SEARCH_*`, `SKETCH_*` (incl. `SKETCH_INFORMAL`, `SKETCH_HOLE_PROVER`, `SKETCH_HARD_ONLY`) — budgets, hammer, goal-level search, sketch-and-fill
- `PROOF_COST_CAP_USD` (per solve / per benchmark theorem), `PROOF_EARLY_STOP` — spend limits
- `PREMISES_ENABLED`, `PREMISE_INDEX_PATH`, `PREMISES_TOP_K`, `PROOF_MEMORY_*` — premise retrieval and proof memory
- `AUTOFORMALIZE_CANDIDATES`, `REFUTE_ENABLED`, `REFUTE_TIMEOUT_MS`, `REFUTE_TRIALS` — formalization voting and counterexample search
- `PROOF_SEARCH_SAMPLES`, `PROOF_SEARCH_BEAM`, `PROOF_SEARCH_MAX_EXPANSIONS`, `SOLVE_MULTI_AGENT` — stepwise search
- `LEAN_SANDBOX_PATH` — Path to lean-sandbox directory
- `LEAN_BUILD_TIMEOUT_MS` — Per-verification timeout
- `LEAN_SERVER_MODE` (`server` = REPL workers, `spawn` = `lake env lean` per file), `LEAN_REPL_WORKERS`, `LEAN_REPL_MAX_USES`, `LEAN_SERVER_STARTUP_MS`, `LEAN_ALLOW_NATIVE_DECIDE` — verification backend
- `LLM_RETRY_*`, `LLM_CACHE_*` — Retry and cache settings
- `COMPUTE_ENGINE_URL` — Python SymPy server URL
- `SESSION_BACKEND` (sqlite | json), `SQLITE_DB_PATH`, `SESSION_STORE_PATH` — session storage
- `AUTH_REQUIRED`, `INVITE_EMAILS`, `INVITE_DOMAINS`, `INVITE_FILE`, `RATE_LIMIT_CALLS_PER_MIN`, `STARTUP_CHECKS` — invite-only beta access and limits (lib/access.ts, lib/model-route.ts, lib/startup-checks.ts)
- `SOLVE_CONCURRENCY`, `JOBS_PER_USER` — solve queue; `RATE_LIMIT_PER_MIN`, `QUOTA_DAILY_USD_FREE|PRO|ENTERPRISE`, `QUOTA_LOCAL_PLAN`, `QUOTA_DB_PATH` — per-user limits

## Running

```bash
npm run dev                    # Start Next.js dev server (Turbopack)
npm run compute                # Start SymPy compute server (python3 scripts/compute-server.py, port 5001; needs `pip3 install sympy`)
npx vitest run                 # Run all test files
npm run build                  # Production build
npm run bench -- --samples 4   # Prover benchmark over bench/theorems.json (LLM key + Lean sandbox required)
npm run bench:fetch            # Download miniF2F → bench/minif2f-test.json; then: npm run bench -- --file bench/minif2f-test.json --limit 20
npm run bench:baseline         # Retest 20 + miniF2F 244 (low budget, cost cap) → bench/BASELINE.md (spends real LLM money)
npm run bench:report -- bench/results/*.json --out bench/BASELINE.md
npm run bench:ablation -- --variants base,no_retrieval,early_stop,sketch   # ablations on 60 theorems → bench/ABLATION.md
npm run bench:formalize -- --sample 40   # autoformalization vs official miniF2F statements → bench/FORMALIZATION.md
npm run premises:build         # Index the sandbox's Mathlib for premise retrieval (minutes; needs the built sandbox)
npm run proofs:harvest -- bench/results/*.json   # verified bench proofs → proof memory
npm run proofs:eval -- --replay                   # memory size + similar-theorem hit rate → bench/MEMORY.md
npm run proofs:export                             # fine-tuning files → data/proof-dataset/
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
2. ~~**Session history sidebar**~~ — done: sidebar on wide screens, slide-out panel otherwise
3. ~~**Real-time progress**~~ — done: SSE with queue place, stage timeline, Cancel
4. **Error UX** — Better error boundaries, loading states, retry buttons

### 🔲 Medium Priority (expand capabilities)
5. **Algebra step-by-step display** — `/api/solve` returns `solution_steps` but UI doesn't render them well
6. **Method comparison view** — Show side-by-side evaluation scores for enumerated methods
7. ~~**Session persistence upgrade**~~ — done: SQLite by default, sessions owned by users
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
