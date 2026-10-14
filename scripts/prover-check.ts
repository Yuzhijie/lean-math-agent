/**
 * One-call check of the prover endpoint before spending money on a benchmark:
 * which model/endpoint/prompt style is in use, how long one sample takes, what it costs,
 * whether a proof can be read from the answer and (when Lean is available) whether it verifies.
 *
 *   npm run prover:check
 *
 * Reads .env.local like the app (LLM_PROVER_MODEL / LLM_PROVER_BASE_URL / LLM_PROVER_API_KEY).
 */
import path from "node:path";
import { loadConfig, nativeProverSettings, proverPromptStyle } from "../lib/llm/config";
import { sampleText } from "../lib/llm/client";
import { WHOLE_PROOF_SYSTEM, nativeProverPrompt, wholeProofUserMessage } from "../lib/llm/prompts";
import { withUsageScope } from "../lib/llm/usage-tracker";
import { extractTactics, helperDeclarationNames } from "../lib/prover/whole-proof";
import { assembleLeanSource } from "../lib/lean/assemble";
import { checkLeanAvailable, verifyLeanSource } from "../lib/lean/sandbox";
import { shutdownReplPool } from "../lib/lean/repl";

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(f));
  } catch {
    /* absent */
  }
}
// The check is about the prover endpoint: an answer from the general model (the usual fallback when
// the prover call fails) would look like a pass while the prover is unreachable.
process.env.LLM_PROVER_FALLBACK_TO_GENERAL = "false";

const NAME = "prover_check";
const TYPE = "(a b : ℝ) (h₀ : 0 < a) (h₁ : 0 < b) : 2 * a * b ≤ a ^ 2 + b ^ 2";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const endpoint = cfg.roles.prover[0];
  const dedicated = !!(process.env.LLM_PROVER_MODEL || process.env.LLM_PROVER_MODELS);
  const style = proverPromptStyle();
  console.log(`prover: ${endpoint.model} @ ${new URL(endpoint.baseUrl).host}${dedicated ? "" : " (no LLM_PROVER_MODEL — the general model)"}; prompt ${style}`);
  if (!endpoint.apiKey) console.log("warning: no API key for the prover endpoint (LLM_PROVER_API_KEY or LLM_API_KEY)");
  if (!cfg.prices[endpoint.model]) console.log(`warning: LLM_PRICES has no entry for "${endpoint.model}", so benchmark costs will be missing`);

  const native = style === "native" ? nativeProverSettings() : undefined;
  const messages =
    style === "native"
      ? [{ role: "user" as const, content: nativeProverPrompt({ theoremName: NAME, theoremType: TYPE }) }]
      : [
          { role: "system" as const, content: WHOLE_PROOF_SYSTEM },
          { role: "user" as const, content: wholeProofUserMessage({ theoremName: NAME, theoremType: TYPE }) },
        ];
  const started = Date.now();
  const limitMs = native?.timeoutMs ?? cfg.timeoutMs;
  console.log(`waiting for the answer (up to ${native?.maxTokens ?? 4096} tokens, timeout ${Math.round(limitMs / 1000)} s; a local model can take minutes)…`);
  // The answer comes in one piece, so say that the call is still running.
  const heartbeat = setInterval(() => console.log(`  … ${Math.round((Date.now() - started) / 1000)} s`), 30_000);
  const { text, metrics } = await withUsageScope(async (m) => {
    const out = await sampleText({ messages, n: 1, role: "prover", maxTokens: native?.maxTokens ?? 4096, timeoutMs: native?.timeoutMs, temperature: native?.temperature ?? 0.8 });
    return { text: out[0] ?? "", metrics: m() };
  }).finally(() => clearInterval(heartbeat));
  const secs = (Date.now() - started) / 1000;
  const model = Object.keys(metrics.by_model)[0];
  console.log(
    `answer: ${secs.toFixed(1)} s, ${metrics.completion_tokens} output tokens (${metrics.completion_tokens ? (metrics.completion_tokens / secs).toFixed(0) : "?"} tok/s)` +
      (metrics.estimated_cost !== undefined ? `, $${metrics.estimated_cost.toFixed(4)}` : "") +
      (model && model !== endpoint.model ? ` — served by ${model} (fallback!)` : ""),
  );
  if (model && model !== endpoint.model) {
    console.log(`the prover ${endpoint.model} did not answer — fix LLM_PROVER_* before a benchmark`);
    process.exitCode = 1;
    return;
  }
  const tactics = extractTactics(text, NAME);
  const helpers = helperDeclarationNames(text, NAME);
  if (!tactics) {
    console.log("no proof could be read from the answer; its last 800 characters:\n" + text.slice(-800));
    process.exitCode = 1;
    return;
  }
  console.log(`proof:\n  ${tactics.split("\n").join("\n  ")}` + (helpers.length ? `\n(helper declarations ignored: ${helpers.join(", ")})` : ""));
  const lean = await checkLeanAvailable();
  if (!lean.ok) {
    console.log(`Lean not available here (${lean.message}); proof not verified`);
    return;
  }
  const v = await verifyLeanSource("prover-check", assembleLeanSource({ theoremName: NAME, theoremType: TYPE, stepCodes: [tactics], useMathlib: true }), { theoremName: NAME });
  console.log(v.ok ? "Lean: verified ✓" : `Lean: not verified — ${v.log.split("\n").find((l) => /error/.test(l)) ?? v.status}`);
  shutdownReplPool();
}

main().catch((e) => {
  console.error(`the prover call failed: ${e instanceof Error ? e.message : e}`);
  console.error("Check LLM_PROVER_MODEL (the exact model id the host lists), LLM_PROVER_BASE_URL and LLM_PROVER_API_KEY.");
  process.exit(1);
});
