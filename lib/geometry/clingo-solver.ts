/**
 * Geometry solver using Clingo ASP (Answer Set Programming)
 * Handles geometric construction and proof via constraint solving
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface Point {
  name: string;
  x?: number;
  y?: number;
}

export interface Line {
  p1: string;
  p2: string;
}

export interface Circle {
  center: string;
  radius?: number;
  passesThrough?: string[];
}

export interface Angle {
  vertex: string;
  p1: string;
  p2: string;
  measure?: number;
}

export interface GeometryProblem {
  points: Point[];
  lines: Line[];
  circles: Circle[];
  angles: Angle[];
  constraints: string[];
  goal: string;
}

export interface GeometrySolution {
  model: Record<string, any>;
  construction: string[];
  proof: string[];
  verified: boolean;
}

// ─── ASP Program Generation ────────────────────────────────────

export function generateASP(problem: GeometryProblem): string {
  const lines: string[] = [];

  // Domain predicates
  lines.push('% Domain declarations');
  for (const p of problem.points) {
    lines.push(`point(${p.name.toLowerCase()}).`);
  }

  // Lines
  lines.push('\n% Line constraints');
  for (const l of problem.lines) {
    lines.push(`line(${l.p1.toLowerCase()}, ${l.p2.toLowerCase()}).`);
    lines.push(`collinear(${l.p1.toLowerCase()}, ${l.p2.toLowerCase()}).`);
  }

  // Circles
  lines.push('\n% Circle constraints');
  for (const c of problem.circles) {
    lines.push(`circle(${c.center.toLowerCase()}).`);
    if (c.radius) {
      lines.push(`radius(${c.center.toLowerCase()}, ${c.radius}).`);
    }
    for (const pt of c.passesThrough || []) {
      lines.push(`on_circle(${pt.toLowerCase()}, ${c.center.toLowerCase()}).`);
    }
  }

  // Angles
  lines.push('\n% Angle constraints');
  for (const a of problem.angles) {
    lines.push(`angle(${a.vertex.toLowerCase()}, ${a.p1.toLowerCase()}, ${a.p2.toLowerCase()}).`);
    if (a.measure !== undefined) {
      lines.push(`angle_measure(${a.vertex.toLowerCase()}, ${a.measure}).`);
    }
  }

  // Custom constraints
  lines.push('\n% Additional constraints');
  for (const c of problem.constraints) {
    lines.push(c);
  }

  // Geometric axioms
  lines.push(`
% Geometric axioms
% Two points determine a line
determined_line(P1, P2) :- point(P1), point(P2), P1 != P2.

% Collinearity is transitive
collinear(A, C) :- collinear(A, B), collinear(B, C), A != C.

% Equal distances from circle center
equal_distance(P1, P2, C) :- on_circle(P1, C), on_circle(P2, C).

% Triangle angle sum = 180
angle_sum_180(A, B, C) :- triangle(A, B, C),
  angle_measure(A, MA), angle_measure(B, MB), angle_measure(C, MC),
  MA + MB + MC = 180.

% Parallel lines
parallel(L1A, L1B, L2A, L2B) :- line(L1A, L1B), line(L2A, L2B),
  not intersect(L1A, L1B, L2A, L2B).

% Perpendicular
perpendicular(L1A, L1B, L2A, L2B) :-
  angle(V, L1A, L2A), angle_measure(V, 90),
  line(L1A, V), line(L2A, V).

% Triangle predicate
triangle(A, B, C) :- line(A, B), line(B, C), line(A, C),
  A != B, B != C, A != C.
`);

  // Goal
  lines.push(`\n% Goal: ${problem.goal}`);
  lines.push(`:- not goal_satisfied.`);

  return lines.join('\n');
}

// ─── Clingo Execution ──────────────────────────────────────────

export async function solveWithClingo(
  program: string,
  models: number = 1,
  timeout: number = 30000
): Promise<{ answerSets: string[][]; satisfiable: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync('clingo', [
      '-',
      `--models=${models}`,
      '--outf=1',  // JSON output
      `--time-limit=${Math.floor(timeout / 1000)}`,
    ], {
      input: program,
      timeout,
    });

    const result = JSON.parse(stdout);
    const answerSets = result.Call?.[0]?.Witnesses?.map((w: any) => w.Value) || [];

    return {
      answerSets,
      satisfiable: result.Call?.[0]?.Result === 'SATISFIABLE',
    };
  } catch (error: any) {
    if (error.stderr?.includes('UNSATISFIABLE')) {
      return { answerSets: [], satisfiable: false };
    }
    throw new Error(`Clingo execution failed: ${error.message}`);
  }
}

// ─── Solution Parsing ──────────────────────────────────────────

export function parseAnswerSet(answerSet: string[]): GeometrySolution {
  const model: Record<string, any> = {};
  const construction: string[] = [];
  const proof: string[] = [];

  for (const atom of answerSet) {
    // Handle bare atoms (no parentheses) like goal_satisfied
    if (!atom.includes('(')) {
      if (atom === 'goal_satisfied') {
        model.goal_satisfied = true;
      }
      continue;
    }

    const match = atom.match(/^(\w+)\((.+)\)$/);
    if (!match) continue;

    const [, predicate, argsStr] = match;
    const args = argsStr.split(',').map(a => a.trim());

    switch (predicate) {
      case 'point':
        model[`point_${args[0]}`] = { name: args[0] };
        construction.push(`定义点 ${args[0].toUpperCase()}`);
        break;
      case 'line':
        model[`line_${args[0]}_${args[1]}`] = { p1: args[0], p2: args[1] };
        construction.push(`连接 ${args[0].toUpperCase()}${args[1].toUpperCase()}`);
        break;
      case 'on_circle':
        model[`on_circle_${args[0]}_${args[1]}`] = { point: args[0], center: args[1] };
        construction.push(`点 ${args[0].toUpperCase()} 在圆 ${args[1].toUpperCase()} 上`);
        break;
      case 'angle_measure':
        model[`angle_${args[0]}`] = { vertex: args[0], measure: parseFloat(args[1]) };
        proof.push(`∠${args[0].toUpperCase()} = ${args[1]}°`);
        break;
      case 'parallel':
        proof.push(`${args[0].toUpperCase()}${args[1].toUpperCase()} ∥ ${args[2].toUpperCase()}${args[3].toUpperCase()}`);
        break;
      case 'perpendicular':
        proof.push(`${args[0].toUpperCase()}${args[1].toUpperCase()} ⊥ ${args[2].toUpperCase()}${args[3].toUpperCase()}`);
        break;
      case 'equal_distance':
        proof.push(`|${args[2].toUpperCase()}${args[0].toUpperCase()}| = |${args[2].toUpperCase()}${args[1].toUpperCase()}|`);
        break;
      case 'goal_satisfied':
        model.goal_satisfied = true;
        break;
    }
  }

  return {
    model,
    construction,
    proof,
    verified: model.goal_satisfied === true,
  };
}

// ─── High-Level Solver ─────────────────────────────────────────

export async function solveGeometry(
  problem: GeometryProblem
): Promise<GeometrySolution | null> {
  const asp = generateASP(problem);
  const result = await solveWithClingo(asp);

  if (!result.satisfiable || result.answerSets.length === 0) {
    return null;
  }

  return parseAnswerSet(result.answerSets[0]);
}

// ─── NL to Geometry Problem ────────────────────────────────────

export function parseGeometryNL(nl: string): Partial<GeometryProblem> {
  const points: Point[] = [];
  const lines: Line[] = [];
  const circles: Circle[] = [];
  const angles: Angle[] = [];
  const constraints: string[] = [];

  // Extract point names (single uppercase letters)
  const pointMatches = nl.match(/[A-Z]/g) || [];
  for (const p of new Set(pointMatches)) {
    points.push({ name: p });
  }

  // Extract triangle
  if (/三角形|△/.test(nl)) {
    const triMatch = nl.match(/[A-Z]{3}|△([A-Z]{3})/);
    if (triMatch) {
      const [a, b, c] = (triMatch[1] || triMatch[0]).split('');
      lines.push({ p1: a, p2: b }, { p1: b, p2: c }, { p1: a, p2: c });
    }
  }

  // Extract parallel
  if (/平行|∥/.test(nl)) {
    const parallelMatch = nl.match(/([A-Z]{2}).*平行.*([A-Z]{2})|([A-Z]{2}).*∥.*([A-Z]{2})/);
    if (parallelMatch) {
      const [, p1a, p1b, p2a, p2b] = parallelMatch;
      constraints.push(`parallel(${(p1a||p2a).toLowerCase()}, ${(p1b||p2b).toLowerCase()}, ${(p2a||p1a).toLowerCase()}, ${(p2b||p1b).toLowerCase()}).`);
    }
  }

  // Extract perpendicular
  if (/垂直|⊥/.test(nl)) {
    constraints.push('% perpendicular constraint');
  }

  // Extract angle measure
  const angleMatch = nl.match(/[∠∠]([A-Z])\s*=\s*(\d+)/);
  if (angleMatch) {
    angles.push({ vertex: angleMatch[1], p1: '', p2: '', measure: parseInt(angleMatch[2]) });
  }

  // Extract circle
  if (/圆|⊙/.test(nl)) {
    const circleMatch = nl.match(/[⊙圆]\s*([A-Z])/);
    if (circleMatch) {
      circles.push({ center: circleMatch[1], passesThrough: [] });
    }
    // Extract radius if present (e.g. 半径为 5, 半径=5, r=5)
    const radiusMatch = nl.match(/半径[为是=]?\s*(\d+(?:\.\d+)?)/);
    if (radiusMatch && circles.length > 0) {
      circles[circles.length - 1].radius = parseFloat(radiusMatch[1]);
    }
  }

  return { points, lines, circles, angles, constraints };
}
