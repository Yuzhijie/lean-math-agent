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
//   "by decide" + FALSE_STMT / TRUE_STMT → refutation probes: the negation
//                           decides (no error) / "evaluates to false"; otherwise
//                           "failed to synthesize Decidable"
//   "plausible" + PLAUSIBLE_CE / PLAUSIBLE_OK → "Found a counter-example!" error
//                           / silence; otherwise "Failed to create a `testable`…"
//   "STDOUT_NOISE"        → a stray non-JSON line is printed before the response
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
  // Positions are computed from the command text, like real Lean's.
  const cmdLines = cmd.split("\n");
  const lineOf = (re) => cmdLines.findIndex((l) => re.test(l)) + 1; // 1-based, 0 = not found
  const theoremLine = lineOf(/^\s*(theorem|lemma|example)\b/) || 1;
  if (cmd.includes("error_here")) {
    const line = lineOf(/error_here/) || 2;
    const column = Math.max(0, cmdLines[line - 1].indexOf("error_here"));
    messages.push({
      severity: "error",
      pos: { line, column },
      endPos: { line, column: column + 10 },
      data: "unsolved goals\nn : Nat\n⊢ n + 0 = n",
    });
  }
  if (/by decide/.test(cmd)) {
    const line = lineOf(/by decide/) || 1;
    if (cmd.includes("TRUE_STMT")) {
      messages.push({ severity: "error", pos: { line, column: 0 }, data: "tactic 'decide' proved that the proposition\n  ¬TRUE_STMT\nis false" });
    } else if (!cmd.includes("FALSE_STMT")) {
      messages.push({ severity: "error", pos: { line, column: 0 }, data: "failed to synthesize\n  Decidable (∀ (n : Nat), n - 1 + 1 = n)" });
    }
  }
  if (/\bplausible\b/.test(cmd)) {
    const line = lineOf(/plausible/) || 1;
    if (cmd.includes("PLAUSIBLE_CE")) {
      messages.push({ severity: "error", pos: { line, column: 2 }, data: "Found a counter-example!\nn := 0\nissue: 0 < 0 does not hold\n(0 shrinks)\n-------------------" });
    } else if (!cmd.includes("PLAUSIBLE_OK")) {
      messages.push({ severity: "error", pos: { line, column: 2 }, data: "Failed to create a `testable` instance for `∀ (x : ℝ), 0 ≤ x ^ 2`." });
    }
  }
  const usesSorry = /\b(sorry|admit)\b/.test(cmd);
  if (usesSorry) {
    messages.push({ severity: "warning", pos: { line: theoremLine, column: 8 }, endPos: { line: theoremLine, column: 11 }, data: "declaration uses `sorry`" });
    let proofState = 0;
    cmdLines.forEach((l, i) => {
      const re = /\b(sorry|admit)\b/g;
      let m;
      while ((m = re.exec(l)) !== null) {
        sorries.push({ proofState: proofState++, pos: { line: i + 1, column: m.index }, endPos: { line: i + 1, column: m.index + m[0].length }, goal: "n : Nat\n⊢ n + 0 = n" });
      }
    });
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
  if (cmd.includes("STDOUT_NOISE")) {
    process.stdout.write("Unable to find a counter-example\n" + JSON.stringify(resp, null, 1) + "\n\n");
    return;
  }
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
