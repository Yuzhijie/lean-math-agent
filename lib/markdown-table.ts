/**
 * Markdown tables inside question text.
 *
 * Questions read from scans keep their tables as Markdown inside the stem
 * ("| Day | Books |\n|---|---|\n| Mon | 3 |"). This module finds those
 * blocks so they can be rendered as tables, detected in templates, and
 * moved into a drawn table figure. Pure: used in the browser and on the server.
 */

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

export type TableSegment = { kind: "text"; text: string } | { kind: "table"; table: ParsedTable; raw: string };

const ROW = /^\s*\|.*\|\s*$/;
const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  // Split on pipes that are not escaped (\|).
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Split text into plain-text and table segments. A table is a header row, a separator row and ≥ 1 body row. */
export function splitTables(text: string): TableSegment[] {
  const lines = text.split("\n");
  const out: TableSegment[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) out.push({ kind: "text", text: buf.join("\n") });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (ROW.test(lines[i]) && i + 1 < lines.length && SEP.test(lines[i + 1])) {
      const headers = cells(lines[i]);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && ROW.test(lines[j])) {
        const r = cells(lines[j]);
        rows.push(headers.map((_, k) => r[k] ?? ""));
        j++;
      }
      if (rows.length) {
        // Drop the newline that separated the table from the text before it.
        if (buf.length && buf[buf.length - 1] === "") buf.pop();
        flush();
        out.push({ kind: "table", table: { headers, rows }, raw: lines.slice(i, j).join("\n") });
        i = j - 1;
        continue;
      }
    }
    buf.push(lines[i]);
  }
  flush();
  return out;
}

export function hasMarkdownTable(text: string): boolean {
  return splitTables(text).some((s) => s.kind === "table");
}

/** The tables in a text. */
export function tablesIn(text: string): ParsedTable[] {
  return splitTables(text).flatMap((s) => (s.kind === "table" ? [s.table] : []));
}

/** The text without its tables (blank lines around them collapsed). */
export function withoutTables(text: string): string {
  return splitTables(text)
    .filter((s) => s.kind === "text")
    .map((s) => (s as { text: string }).text.trim())
    .filter(Boolean)
    .join("\n");
}
