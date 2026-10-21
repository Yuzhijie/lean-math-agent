/**
 * `npm run prover:serve` — serve the prover expert iteration promoted (.data/expert-iteration.json)
 * with mlx_lm on 127.0.0.1:<port> (default 8089), the endpoint `--apply` wrote into .env.local
 * (LLM_PROVER_BASE_URL=http://127.0.0.1:8089/v1). Runs in the foreground; Ctrl-C stops it.
 *
 *   npm run prover:serve [-- --port 8089]
 *
 * When no fine-tuned prover has been promoted yet, the app keeps using LLM_PROVER_* as configured.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mlxServeArgs, readRegistry } from "../lib/prover/expert-iteration";

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(f));
  } catch {
    // optional
  }
}

const i = process.argv.indexOf("--port");

async function main(): Promise<void> {
  const reg = await readRegistry();
  // The port expert iteration promoted the model on (and wrote into .env.local), unless given.
  const port = i >= 0 ? Number(process.argv[i + 1]) : (reg.current.port ?? 8089);
  if (reg.current.kind !== "mlx") {
    console.log(`No fine-tuned prover has been promoted yet; the app uses the configured prover (${reg.current.model}). Run npm run expert:iterate first.`);
    return;
  }
  const python = process.env.EXPERT_PYTHON ?? "python3";
  const args = mlxServeArgs(reg.current.path ?? reg.current.model, port);
  console.log(`Serving ${reg.current.model} (round ${reg.current.round}) on http://127.0.0.1:${port}/v1\n$ ${python} ${args.join(" ")}`);
  const r = spawnSync(python, args, { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
