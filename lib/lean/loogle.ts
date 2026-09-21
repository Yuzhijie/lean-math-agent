/**
 * Optional Loogle client (https://loogle.lean-lang.org — or a self-hosted
 * instance) for looking up Mathlib declarations by name fragment or by type
 * pattern, e.g. `Nat.add_comm`, `_ * (_ + _) = _ * _ + _ * _`,
 * `Real.sqrt, ?a ≤ ?b`.
 *
 * Disabled unless LOOGLE_URL is set; every failure degrades to "no hits".
 * The prover uses it to resolve `unknown identifier` errors (the model
 * remembered a lemma name that does not exist) into real declarations.
 */

export interface LoogleHit {
  name: string;
  type: string;
  module: string;
  doc?: string;
}

export interface LoogleOptions {
  /** Max hits to return (default 6). */
  limit?: number;
  /** Request timeout (default 8 s). */
  timeoutMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override LOOGLE_URL. */
  baseUrl?: string;
}

export function loogleBaseUrl(override?: string): string | undefined {
  const raw = (override ?? process.env.LOOGLE_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

export function isLoogleEnabled(): boolean {
  return loogleBaseUrl() !== undefined;
}

/** Query Loogle. Returns [] when disabled, on error, or when nothing matches. */
export async function loogleSearch(query: string, opts: LoogleOptions = {}): Promise<LoogleHit[]> {
  const base = loogleBaseUrl(opts.baseUrl);
  const q = query.trim();
  if (!base || !q) return [];
  const limit = opts.limit ?? 6;
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${base}/json?q=${encodeURIComponent(q)}`, {
      headers: { Accept: "application/json", "User-Agent": "lean-math-agent" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      hits?: Array<{ name?: string; type?: string; module?: string; doc?: string }>;
      error?: string;
    };
    if (data.error || !Array.isArray(data.hits)) return [];
    return data.hits
      .filter((h) => typeof h.name === "string" && typeof h.type === "string")
      .slice(0, limit)
      .map((h) => ({ name: h.name!, type: h.type!, module: h.module ?? "", doc: h.doc }));
  } catch {
    return [];
  }
}

const UNKNOWN_ID_RE = /unknown (?:identifier|constant) '([^']+)'/g;

/** Identifiers Lean could not resolve, from error messages (deduplicated). */
export function unknownIdentifiers(messages: string[]): string[] {
  const out = new Set<string>();
  for (const msg of messages) {
    for (const m of msg.matchAll(UNKNOWN_ID_RE)) out.add(m[1]);
  }
  return [...out];
}

/**
 * For each unresolved identifier, look up declarations with a similar name
 * (last name component). Returns a prompt block, or "" when nothing found.
 */
export async function loogleHintsForUnknownIdentifiers(
  messages: string[],
  opts: LoogleOptions = {},
): Promise<string> {
  const ids = unknownIdentifiers(messages).slice(0, 3);
  if (ids.length === 0 || !loogleBaseUrl(opts.baseUrl)) return "";
  const blocks: string[] = [];
  for (const id of ids) {
    const tail = id.split(".").pop() ?? id;
    const hits = await loogleSearch(tail, { ...opts, limit: opts.limit ?? 5 });
    if (hits.length === 0) continue;
    blocks.push(
      `\`${id}\` does not exist. Declarations named like \`${tail}\` (from Loogle):\n` +
        hits.map((h) => `- ${h.name} : ${h.type}`).join("\n"),
    );
  }
  return blocks.join("\n\n");
}
