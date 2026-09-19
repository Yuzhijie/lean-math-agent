# P3 Features Implementation Guide

This document describes the 7 P3 (Low Priority) features implemented in v0.2.0.

## Overview

| # | Feature | Status | Files |
|---|---------|--------|-------|
| 10 | User Authentication (NextAuth) | ✅ Done | `lib/auth.ts`, `app/api/auth/`, `app/auth/` |
| 11 | Payment System (Stripe/Alipay) | ✅ Done | `lib/payments/`, `app/api/payments/` |
| 12 | Knowledge Graph (Neo4j) | ✅ Done | `lib/knowledge/`, `app/api/knowledge/` |
| 13 | Geometry Solver (Clingo ASP) | ✅ Done | `lib/geometry/`, `app/api/solve-geometry/` |
| 14 | Algebra Solver Module (Python) | ✅ Done | `scripts/solve/` |
| 15 | Docker Deployment | ✅ Done | `Dockerfile`, `docker-compose.yml` |
| 16 | i18n Bilingual Support | ✅ Done | `lib/i18n/`, `app/components/LocaleSwitcher.tsx` |

---

## 10. User Authentication (NextAuth)

### Setup

1. Add environment variables to `.env`:
```bash
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<generate-with-openssl-rand-base64-32>
DATABASE_URL=file:.data/prod.db

# Optional OAuth
GITHUB_ID=<your-github-oauth-app-id>
GITHUB_SECRET=<your-github-oauth-secret>
GOOGLE_ID=<your-google-client-id>
GOOGLE_SECRET=<your-google-client-secret>
```

2. Generate Prisma client:
```bash
npx prisma generate
npx prisma db push
```

### Architecture

- **Provider**: NextAuth v4 with JWT sessions
- **Adapter**: Prisma adapter for SQLite/PostgreSQL
- **Providers**: GitHub, Google, Credentials (email/password)
- **Session strategy**: JWT (stateless, 30-day expiry)

### API Endpoints

- `GET/POST /api/auth/[...nextauth]` — NextAuth handler
- Auth pages: `/auth/signin`, `/auth/signout`, `/auth/error`

### Components

- `<AuthButton />` — Login/logout dropdown with avatar
- `<Providers />` — SessionProvider wrapper

---

## 11. Payment System (Stripe)

### Setup

1. Create Stripe account and get API keys
2. Create products and prices in Stripe dashboard
3. Add environment variables:
```bash
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRO_PRICE_ID=price_xxx
STRIPE_ENTERPRISE_PRICE_ID=price_xxx
```

### Plans

| Plan | Price | Proofs/month | History | Concurrent |
|------|-------|-------------|---------|-----------|
| Free | ¥0 | 10 | 7 days | 1 |
| Pro | ¥49/mo | 500 | Unlimited | 4 |
| Enterprise | ¥199/mo | Unlimited | Unlimited | Unlimited |

### API Endpoints

- `POST /api/payments/checkout` — Create Stripe checkout session
- `POST /api/payments/webhook` — Handle Stripe webhook events

### Components

- `<PricingCards />` — Subscription plan cards with checkout
- Subscription page: `/subscription`

### Webhook Events Handled

- `checkout.session.completed` — Activate subscription
- `customer.subscription.updated` — Update plan/status
- `customer.subscription.deleted` — Mark as expired
- `invoice.payment_failed` — Notify user

---

## 12. Knowledge Graph (Neo4j)

### Setup

1. Run Neo4j (included in docker-compose):
```bash
docker compose up neo4j -d
```

2. Add environment variables:
```bash
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<your-password>
```

3. Seed initial data:
```bash
curl -X POST http://localhost:3000/api/knowledge/stats
```

### Node Types

- **Concept** — Math concepts (natural numbers, polynomials, etc.)
- **Theorem** — Named theorems with statements
- **Method** — Proof methods (induction, contradiction, etc.)
- **Proof** — Recorded proof instances

### Relationship Types

- `PREREQUISITE_OF` — A is needed to understand B
- `USES_CONCEPT` — Method/theorem uses a concept
- `PROVES` — Proof proves a theorem
- `USES_METHOD` — Proof uses a method
- `GENERALIZES` / `SPECIALIZES` — Concept hierarchy
- `RELATED_TO` — General relation

### API Endpoints

- `POST /api/knowledge/search` — Search nodes by query
- `POST /api/knowledge/graph` — Get subgraph for a node
- `GET /api/knowledge/stats` — Get graph statistics
- `POST /api/knowledge/stats` — Seed initial concepts

### Components

- `<KnowledgeGraph />` — Interactive SVG graph visualization
- Knowledge page: `/knowledge`

---

## 13. Geometry Solver (Clingo ASP)

### Setup

1. Install Clingo:
```bash
# macOS
brew install clingo

# Ubuntu/Debian
apt install clingo

# Or from source: https://github.com/potassco/clingo
```

2. Set environment variable (optional):
```bash
CLINGO_PATH=clingo  # or /path/to/clingo
```

### Architecture

The geometry solver uses Answer Set Programming (ASP) to:
1. Translate geometric constraints into ASP rules
2. Run Clingo to find satisfying models
3. Parse answer sets into construction steps and proofs

### ASP Axioms Included

- Point/line/circle predicates
- Collinearity (transitive)
- Triangle definition
- Angle sum = 180°
- Parallel and perpendicular detection
- Equal distances on circles

### API Endpoint

- `POST /api/solve-geometry` — Solve geometry problem
  - Input: `{ problem: GeometryProblem }` or `{ nlDescription: string }`
  - Output: `{ satisfiable, solution: { construction, proof, verified } }`

### Components

- `<GeometryDiagram />` — Interactive SVG geometry visualization

---

## 14. Algebra Solver Module (Python)

### Setup

```bash
cd scripts
pip install -r requirements.txt
python compute-server-v2.py
```

### Architecture

```
scripts/solve/
├── __init__.py       # Package exports
├── parser.py         # Expression/equation parser (Chinese + English)
├── steps.py          # Step-by-step recording
├── solver.py         # Main solver (linear, quadratic, polynomial, systems)
└── endpoints.py      # Flask HTTP endpoints
```

### Capabilities

- **Linear equations**: ax + b = 0 → step-by-step with verification
- **Quadratic equations**: ax² + bx + c = 0 → discriminant analysis + roots
- **Polynomial equations**: degree 3-4 → factoring + root finding
- **Systems of equations**: multi-variable → solution sets with verification
- **Inequalities**: univariate → solution intervals
- **Expression simplification**: expand, factor, simplify

### HTTP Endpoints

- `POST /algebra/solve` — Solve single equation
- `POST /algebra/solve-system` — Solve system of equations
- `POST /algebra/simplify` — Simplify expression
- `POST /algebra/solve-inequality` — Solve inequality
- `POST /algebra/factor` — Factor expression

### Chinese Notation Support

The parser handles Chinese math notation:
- 加 → +, 减 → -, 乘 → *, 除 → /
- 等于 → =
- 平方 → **2, 立方 → **3
- 根号/√ → sqrt

---

## 15. Docker Deployment

### Quick Start

```bash
# Build all services
docker compose build

# Start everything
docker compose up -d

# Check status
docker compose ps
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| web | 3000 | Next.js application |
| compute | 8765 | Python SymPy + Algebra server |
| neo4j | 7474, 7687 | Knowledge graph database |
| nginx | 80, 443 | Reverse proxy (production) |

### Docker Files

- `Dockerfile` — Multi-stage Next.js build
- `Dockerfile.compute` — Python compute server
- `docker-compose.yml` — Service orchestration
- `nginx.conf` — Reverse proxy with rate limiting
- `.dockerignore` — Build context exclusions

### Production Deployment

```bash
# With nginx + HTTPS
docker compose --profile production up -d

# Place SSL certificates in ./certs/
# Update nginx.conf with your domain
```

### Environment Variables

All environment variables are passed through docker-compose.yml.
Create a `.env` file in the project root.

---

## 16. i18n Bilingual Support

### Supported Locales

| Locale | Name | Status |
|--------|------|--------|
| zh-CN | 简体中文 | Default, complete |
| en-US | English | Complete |

### Architecture

- **Provider**: React Context (`I18nProvider`)
- **Hook**: `useI18n()` returns `{ locale, setLocale, t }`
- **Storage**: Cookie-based locale persistence

### Translation Files

- `lib/i18n/zh-CN.ts` — Chinese translations (default)
- `lib/i18n/en-US.ts` — English translations
- `lib/i18n/config.ts` — Locale configuration
- `lib/i18n/index.ts` — Provider and hook

### Usage

```tsx
import { useI18n } from '@/lib/i18n';

function MyComponent() {
  const { t, locale, setLocale } = useI18n();

  return (
    <div>
      <h1>{t('home.title')}</h1>
      <p>{t('auth.signInWith', { provider: 'GitHub' })}</p>
      <button onClick={() => setLocale('en-US')}>
        Switch to English
      </button>
    </div>
  );
}
```

### Translation Keys

Organized by section:
- `common.*` — Shared UI text
- `auth.*` — Authentication
- `home.*` — Home page
- `problem.*` — Problem types
- `proof.*` — Proof-related text
- `solution.*` — Solution display
- `session.*` — Session management
- `subscription.*` — Subscription plans
- `knowledge.*` — Knowledge graph
- `errors.*` — Error messages

### Components

- `<LocaleSwitcher />` — Dropdown locale selector

---

## Database Schema (Prisma)

The P3 features introduce these new models:

```prisma
User          — Authentication + profile
Account       — OAuth accounts (NextAuth)
Session       — Login sessions (NextAuth)
Subscription  — Payment subscription
ProofSession  — Saved proof sessions (with userId)
```

Run migrations:
```bash
npx prisma generate
npx prisma db push
npx prisma studio  # Visual database browser
```

---

## Testing

```bash
# Run all tests
npx vitest run

# Run P3-specific tests
npx vitest run tests/i18n.test.ts
npx vitest run tests/clingo-solver.test.ts
npx vitest run tests/neo4j-client.test.ts
npx vitest run tests/stripe.test.ts
```

---

## Dependencies Added

### npm

```
@next-auth/prisma-adapter  — NextAuth Prisma adapter
@prisma/client             — Database client
@radix-ui/react-avatar     — Avatar component
@radix-ui/react-dropdown-menu — Dropdown menu
neo4j-driver               — Neo4j client
next-auth                  — Authentication
stripe                     — Stripe SDK
prisma                     — Database toolkit
```

### Python (scripts/requirements.txt)

```
sympy>=1.12
flask>=3.0
flask-cors>=4.0
```

### System (for geometry solver)

```
clingo — ASP solver (brew install / apt install)
```
