/**
 * What a proved statement does not cover. Lean certifies the statement as written; whether the
 * statement is the problem is decided before Lean, by the formalizer and the validation layers.
 * Reading 114 stored statements (bench/FORMALIZATION-AUDIT.md) found that the common failure is
 * not a wrong statement but a hollow one — true to the problem, with the hard part done outside
 * Lean. Two kinds are visible to the program:
 *
 *  - the problem came with a figure: what the figure shows is in the statement the way the model
 *    read it (a spinner's labels, which picture shows half a bottle), and Lean cannot see the figure;
 *  - the statement is a closed computation with numbers the problem does not give: a focus, a
 *    tangent point, a line's equation were worked out while solving and plugged in, and Lean
 *    checks the last line of arithmetic.
 *
 * `scopeNotes` says so next to "Lean 已证" (lib/pipeline/lean-attempt.ts); the audit counts both.
 */
import { lt } from "../llm/output-locale";
import { mainAssignmentIndex } from "./sanitize";

export interface StatementScope {
  /** The problem text carries a figure description (lib/bank/problem-figures.ts problemWithFigure). */
  figure: boolean;
  /** No variable anywhere: no binder before the colon, no quantifier, implication or function. */
  closed: boolean;
  /** Numbers of a closed statement that are neither in the problem nor in the answer. */
  derived: string[];
}

/** What lib/bank/problem-figures.ts puts between a problem's text and its figure's description. */
export const FIGURE_MARK = /【题目图形（由模型从图中读取）】|\[Figure, as read from the image by the model\]/;

/** `theorem name <type> := <proof>`, a whole verified source, or a bare type → the type on one line. */
export function statementType(statement: string): string {
  const at = statement.search(/(?:^|\n)\s*theorem\s+\S+/);
  const body = at >= 0 ? statement.slice(at).replace(/^\s*theorem\s+\S+\s*/, "") : statement;
  const proof = mainAssignmentIndex(body);
  return (proof >= 0 ? body.slice(0, proof) : body).replace(/\s+/g, " ").trim();
}

/** The numbers written in a text ("13,14,15" → 13, 14, 15; "h₁", "x2", "Fin.succ" are not numbers). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z_'₀-₉\d.])\d+(?:\.\d+)?(?![A-Za-z_\d])/g)) {
    const v = Number(m[0]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** What a closed statement asserts as the result: the text after its last `=` outside brackets ("… = 56 / 3"). */
function resultOf(type: string): string {
  let depth = 0;
  let at = -1;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === "=" && depth === 0 && !":<>≠!=".includes(type[i - 1] ?? "") && type[i + 1] !== "=" && type[i + 1] !== ">") at = i;
  }
  return at >= 0 ? type.slice(at + 1) : "";
}

export function statementScope(problem: string, statement: string, answers: string[] = []): StatementScope {
  const type = statementType(statement);
  // a binder: a quantifier, an implication, a function, a set-builder `{x | …}`; collections count as one
  // (`Finset.range 10` for 1 … 9 would make 10 look like a number the problem does not give)
  const closed = /^:/.test(type) && !/[∀∃λ∑∏→]|\bfun\b|=>|\{\s*[A-Za-z_][^{}|]*\||\b(?:Set|Finset|List|Multiset)\b/.test(type);
  const derived: string[] = [];
  if (closed) {
    // given: the problem's numbers, the answer's, and the result the statement itself asserts
    const given = new Set<number>([0, 1, 2, 10, 100, ...numbersIn(problem), ...answers.flatMap(numbersIn), ...numbersIn(resultOf(type))]);
    // degrees written as radians: 60° → π / 3
    for (const g of [...given]) if (g > 0 && Number.isInteger(180 / g)) given.add(180 / g);
    for (const v of numbersIn(type)) {
      if (!given.has(v) && !derived.includes(String(v))) derived.push(String(v));
    }
  }
  return { figure: FIGURE_MARK.test(problem), closed, derived };
}

/** The notes shown with a proved statement (none when the proof covers the problem as far as the program can tell). */
export function scopeNotes(scope: StatementScope): string[] {
  const notes: string[] = [];
  if (scope.figure) {
    notes.push(
      lt(
        "这道题带图。陈述里关于图的内容，是模型按读到的图写进去的；Lean 证明的是这样写出来的陈述，不检查它与图是否一致。",
        "This problem came with a figure. What the statement says about it was written by the model from its reading of the figure; Lean proved the statement as written and does not check it against the figure.",
      ),
    );
  }
  if (scope.closed && scope.derived.length) {
    const nums = scope.derived.slice(0, 6).join("、");
    notes.push(
      lt(
        `这条陈述是一个不含未知量的算式，其中的 ${nums} 不是题目给出的数，而是解题过程中算出来再代进去的。Lean 核对的是最后这一步计算，之前的推导不在证明之内。`,
        `This statement is a closed computation, and ${scope.derived.slice(0, 6).join(", ")} in it are not given by the problem: they were worked out while solving and plugged in. Lean checked this last computation, not the derivation before it.`,
      ),
    );
  }
  return notes;
}
