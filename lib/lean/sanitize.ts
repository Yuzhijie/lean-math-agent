// ── Lean source sanitizer ─────────────────────────────────────────────
//
// Everything sent to the verifier is LLM output derived from user text, and
// Lean elaboration can run arbitrary code: `#eval` executes IO, `elab` /
// `macro_rules` / `initialize` run meta-programs at elaboration time,
// `@[extern]` / `implemented_by` / `unsafe` bypass the kernel, and `axiom`
// lets anything be "proved". None of these are needed to write a proof, so
// they are rejected before the source reaches Lean.
//
// The checks run on the source with comments and string literals removed,
// so a keyword inside `-- ...` or `"..."` neither triggers a false positive
// nor hides a real command.

export interface SanitizeOk {
  ok: true;
}

export interface SanitizeRejected {
  ok: false;
  /** Human-readable reason (Chinese, shown to the user / fed to the LLM). */
  reason: string;
  /** The offending tokens, in order of appearance. */
  matches: string[];
}

export type SanitizeResult = SanitizeOk | SanitizeRejected;

/** Commands / keywords that can execute code, bypass the kernel, or add axioms. */
export const FORBIDDEN_TOKENS = [
  "#eval",
  "#exit",
  "run_cmd",
  "run_meta",
  "run_tac",
  "run_elab",
  "initialize",
  "builtin_initialize",
  "elab",
  "elab_rules",
  "macro",
  "macro_rules",
  "syntax",
  "declare_syntax_cat",
  "unsafe",
  "implemented_by",
  "extern",
  "axiom",
  "import",
] as const;

/** Attributes with the same effect as the forbidden commands. */
const FORBIDDEN_ATTRIBUTES = ["extern", "implemented_by", "init", "export"] as const;

const MAX_SOURCE_LENGTH = 200_000;

const TOKEN_RE = new RegExp(
  `(^|[^A-Za-z0-9_.'!?])(${FORBIDDEN_TOKENS.map(escapeRe).join("|")})(?![A-Za-z0-9_'!?])`,
  "g",
);

const ATTRIBUTE_RE = new RegExp(
  `@\\[[^\\]]*\\b(${FORBIDDEN_ATTRIBUTES.join("|")})\\b[^\\]]*\\]`,
  "g",
);

const ATTRIBUTE_CMD_RE = new RegExp(
  `(^|[^A-Za-z0-9_.'])attribute\\s*\\[[^\\]]*\\b(${FORBIDDEN_ATTRIBUTES.join("|")})\\b`,
  "g",
);

/** `set_option maxHeartbeats 0` / `maxRecDepth 0` disable Lean's own limits. */
const UNBOUNDED_OPTION_RE = /set_option\s+(maxHeartbeats|maxRecDepth|synthInstance\.maxHeartbeats)\s+0\b/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove `-- line` comments, `/- block -/` comments (nested) and string
 * literals, replacing them with spaces so positions of the remaining text
 * stay roughly aligned.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "-" && next === "-") {
      // line comment
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "-") {
      // block comment, possibly nested
      let depth = 0;
      while (i < n) {
        if (src[i] === "/" && src[i + 1] === "-") {
          depth++;
          out += "  ";
          i += 2;
          continue;
        }
        if (src[i] === "-" && src[i + 1] === "/") {
          depth--;
          out += "  ";
          i += 2;
          if (depth === 0) break;
          continue;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (ch === '"') {
      // string literal (with escapes)
      out += " ";
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Split a source file into its header (leading blank lines, comments and
 * `import` lines) and the body. Returns the number of header lines so that
 * positions reported for the body can be mapped back to file positions.
 */
export function splitHeader(source: string): { header: string; imports: string[]; body: string; headerLines: number } {
  const lines = source.split("\n");
  let i = 0;
  const imports: string[] = [];
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("--")) {
      i++;
      continue;
    }
    if (t.startsWith("import ")) {
      imports.push(t.slice("import ".length).trim());
      i++;
      continue;
    }
    break;
  }
  return {
    header: lines.slice(0, i).join("\n"),
    imports,
    body: lines.slice(i).join("\n"),
    headerLines: i,
  };
}

/**
 * Check a full Lean source file (header + body). `import` is only allowed
 * in the header, which the application itself generates.
 */
export function sanitizeLeanSource(source: string): SanitizeResult {
  if (source.length > MAX_SOURCE_LENGTH) {
    return {
      ok: false,
      reason: `Lean 源码超过 ${MAX_SOURCE_LENGTH} 字符上限`,
      matches: [],
    };
  }
  const { body } = splitHeader(source);
  return sanitizeLeanBody(body);
}

/** Check a body (no imports allowed at all). */
export function sanitizeLeanBody(body: string): SanitizeResult {
  const cleaned = stripCommentsAndStrings(body);
  const matches: string[] = [];

  for (const m of cleaned.matchAll(TOKEN_RE)) matches.push(m[2]);
  for (const m of cleaned.matchAll(ATTRIBUTE_RE)) matches.push(`@[${m[1]}]`);
  for (const m of cleaned.matchAll(ATTRIBUTE_CMD_RE)) matches.push(`attribute [${m[2]}]`);
  for (const m of cleaned.matchAll(UNBOUNDED_OPTION_RE)) matches.push(`set_option ${m[1]} 0`);

  if (matches.length === 0) return { ok: true };
  const unique = [...new Set(matches)];
  return {
    ok: false,
    reason: `Lean 源码包含不允许的命令/关键字（可执行代码、绕过内核或引入公理）: ${unique.join(", ")}`,
    matches: unique,
  };
}

// ── Theorem statement validation ──────────────────────────────────────

const LEAN_IDENT_RE = /^[A-Za-z_À-￿][A-Za-z0-9_'À-￿]*(\.[A-Za-z_À-￿][A-Za-z0-9_'À-￿]*)*$/;
const MAX_STATEMENT_LENGTH = 4_000;

/**
 * Validate the `theorem_type` string that the formalizer / planner produce.
 * The final file is `theorem <name> <type> := by <tactics>`, so the type must
 * not be able to close the declaration early (`:=`), start another one
 * (newline + command), or contain anything but the signature itself.
 */
export function validateTheoremStatement(
  name: string,
  theoremType: string,
): { ok: true } | { ok: false; reason: string } {
  if (!LEAN_IDENT_RE.test(name)) {
    return { ok: false, reason: `定理名不是合法的 Lean 标识符: ${JSON.stringify(name)}` };
  }
  const t = theoremType.trim();
  if (t.length === 0) return { ok: false, reason: "定理陈述为空" };
  if (t.length > MAX_STATEMENT_LENGTH) {
    return { ok: false, reason: `定理陈述超过 ${MAX_STATEMENT_LENGTH} 字符上限` };
  }
  if (/[\r\n]/.test(t)) return { ok: false, reason: "定理陈述必须是单行" };
  if (t.includes(":=")) return { ok: false, reason: "定理陈述不能包含 `:=`" };
  if (t.includes("--") || t.includes("/-")) {
    return { ok: false, reason: "定理陈述不能包含注释" };
  }
  if (!t.includes(":")) return { ok: false, reason: "定理陈述缺少 `:`" };
  const first = t[0];
  if (!":({[⦃".includes(first)) {
    return { ok: false, reason: "定理陈述必须以 `:` 或绑定符 `(`、`{`、`[`、`⦃` 开头" };
  }
  const body = sanitizeLeanBody(t);
  if (!body.ok) return { ok: false, reason: body.reason };
  if (/\b(sorry|admit|sorryAx)\b/.test(stripCommentsAndStrings(t))) {
    return { ok: false, reason: "定理陈述不能包含 sorry" };
  }
  return { ok: true };
}
