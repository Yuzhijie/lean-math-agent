#!/usr/bin/env node
// A stand-in for `leanprover-community/repl` used by unit tests.
//
// Speaks the same framing (one-line JSON command + blank line in; pretty
// JSON + blank line out) and reacts to markers in the `cmd` text:
//   "import ..."          → new environment (no `env` in the request)
//   "SLEEP"               → never answers (timeout tests)
//   "BOOM"                → exits with code 3 (crash tests)
//   "error_here"          → an error message
//   "sorry" / "admit"     → a sorry with a goal (+ sorryAx axiom)
//   "native_decide"       → a native_decide axiom
//   "#print axioms NAME"  → info line with axioms
//   "#check @NAME"        → info line `NAME : ∀ (n : Nat), n + 0 = n`
//   "PRETTY"              → response is emitted in many small chunks
import { setTimeout as delay } from "node:timers/promises";

let envCounter = 0;
let buffer = "";
let lines = [];

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === "") {
      if (lines.length > 0) {
        const text = lines.join("");
        lines = [];
        await handle(text);
      }
      continue;
    }
    lines.push(line.trimEnd());
  }
});

process.stdin.on("end", () => process.exit(0));

async function handle(text) {
  let req;
  try {
    req = JSON.parse(text);
  } catch (e) {
    respond({ message: `Could not parse JSON:\n${e.message}` });
    return;
  }
  const cmd = String(req.cmd ?? "");
  if (cmd.includes("SLEEP")) return;
  if (cmd.includes("BOOM")) process.exit(3);
  if (req.env !== undefined && req.env >= envCounter) {
    respond({ message: "Unknown environment." });
    return;
  }
  const env = envCounter++;
  const messages = [];
  const sorries = [];
  if (/(^|\n)\s*import /.test(cmd) && req.env !== undefined) {
    messages.push({ severity: "error", pos: { line: 1, column: 0 }, data: "invalid 'import' command, it must be used in the beginning of the file" });
  }
  if (cmd.includes("error_here")) {
    messages.push({
      severity: "error",
      pos: { line: 2, column: 2 },
      endPos: { line: 2, column: 12 },
      data: "unsolved goals\nn : Nat\n⊢ n + 0 = n",
    });
  }
  const usesSorry = /\b(sorry|admit)\b/.test(cmd);
  if (usesSorry) {
    messages.push({ severity: "warning", pos: { line: 1, column: 8 }, endPos: { line: 1, column: 11 }, data: "declaration uses `sorry`" });
    sorries.push({ proofState: 0, pos: { line: 2, column: 2 }, endPos: { line: 2, column: 7 }, goal: "n : Nat\n⊢ n + 0 = n" });
  }
  const ax = cmd.match(/#print axioms (\S+)/);
  if (ax) {
    const name = ax[1];
    const list = [];
    if (usesSorry) list.push("sorryAx");
    if (cmd.includes("native_decide")) list.push(`${name}._native.native_decide.ax_1`);
    if (cmd.includes("propext")) list.push("propext");
    const line = cmd.split("\n").findIndex((l) => l.startsWith("#print axioms")) + 1;
    messages.push({
      severity: "info",
      pos: { line, column: 0 },
      endPos: { line, column: 6 },
      data: list.length ? `'${name}' depends on axioms: [${list.join(", ")}]` : `'${name}' does not depend on any axioms`,
    });
  }
  const ck = cmd.match(/#check @(\S+)/);
  if (ck) {
    const name = ck[1];
    const line = cmd.split("\n").findIndex((l) => l.startsWith("#check")) + 1;
    const type = cmd.includes("OTHER_STATEMENT") ? "∀ (n : Nat), 0 + n = n" : "∀ (n : Nat), n + 0 = n";
    messages.push({ severity: "info", pos: { line, column: 0 }, endPos: { line, column: 6 }, data: `${name} : ${type}` });
  }
  const resp = { env };
  if (sorries.length) resp.sorries = sorries;
  if (messages.length) resp.messages = messages;
  if (cmd.includes("PRETTY")) {
    const out = JSON.stringify(resp, null, 1) + "\n\n";
    for (const piece of out.match(/.{1,7}/gs) ?? []) {
      process.stdout.write(piece);
      await delay(1);
    }
    return;
  }
  respond(resp);
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj, null, 1) + "\n\n");
}
