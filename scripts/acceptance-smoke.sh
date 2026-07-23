#!/usr/bin/env bash
# Automated smoke: unit/integration tests. Full gold acceptance needs a real LLM + browser.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Vitest (unit + integration) =="
npx vitest run

echo ""
echo "== Manual gold acceptance (requires LLM_API_KEY + lake) =="
echo "See README.md § Acceptance checklist and gold/problems.json"
echo "Run: npm run dev → http://localhost:3000"
