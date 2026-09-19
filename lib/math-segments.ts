// ── Math segment tokenizer ────────────────────────────────────────────
// Splits a string into alternating plain-text and math segments so the UI
// can render math delimiters with KaTeX and leave everything else untouched.
//
// Recognized delimiters:
//   $$...$$    display math
//   \[...\]    display math
//   $...$      inline math
//   \(...\)    inline math
//
// Guards against the common false positives of a naive "$...$" scan:
//   - "$" preceded by a backslash ("\$") is treated as an escaped literal.
//   - Inline content must start and end with a non-whitespace, non-"$" char,
//     which blocks currency pairs like "$5 and $10" from pairing up.
//   - The closing "$" must not be followed by a digit (extra price guard).
//   - An unclosed "$" never matches, so the whole run stays plain text.
//   - Empty display math ("$$ $$") is kept as literal text.

export type MathSegment =
  | { kind: "text"; content: string }
  | { kind: "inline"; content: string }
  | { kind: "display"; content: string };

// Order matters: "$$...$$" must be tried before "$...$".
// Group 1: $$ display, Group 2: \[ display, Group 3: $ inline, Group 4: \( inline.
const SEGMENT_RE =
  /(?<!\\)(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$((?=[^\s$])[^\n$]*?[^\s$])\$(?!\d)|\\\(([\s\S]+?)\\\))/g;

const SEGMENT_KINDS: MathSegment["kind"][] = [
  "display",
  "display",
  "inline",
  "inline",
];

/** Split `input` into an ordered list of text / inline / display segments. */
export function splitMathSegments(input: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let textBuf = "";

  const flushText = () => {
    if (textBuf) {
      segments.push({ kind: "text", content: textBuf.replace(/\\\$/g, "$") });
      textBuf = "";
    }
  };

  // Fresh copy so the module-level regex lastIndex is never shared across calls.
  const re = new RegExp(SEGMENT_RE.source, "g");
  let pos = 0;

  while (pos < input.length) {
    re.lastIndex = pos;
    const m = re.exec(input);
    if (!m) break;

    const gi = [m[1], m[2], m[3], m[4]].findIndex((g) => g !== undefined);
    const content = m[gi + 1];
    const kind = SEGMENT_KINDS[gi];

    // Degenerate display math (e.g. "$$ $$"): keep it verbatim as text.
    if (kind === "display" && content.trim() === "") {
      textBuf += m[0];
      pos = m.index + m[0].length;
      continue;
    }

    textBuf += input.slice(pos, m.index);
    flushText();
    segments.push({ kind, content });
    pos = m.index + m[0].length;
  }

  textBuf += input.slice(pos);
  flushText();
  return segments;
}

/** True when `input` contains at least one math segment. */
export function containsMath(input: string): boolean {
  return splitMathSegments(input).some((s) => s.kind !== "text");
}
