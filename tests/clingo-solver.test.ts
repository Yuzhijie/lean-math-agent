/**
 * Tests for Clingo geometry solver
 */
import { describe, it, expect } from 'vitest';
import {
  generateASP,
  parseAnswerSet,
  parseGeometryNL,
} from '../lib/geometry/clingo-solver';

describe('Geometry Solver - ASP Generation', () => {
  it('should generate point predicates', () => {
    const asp = generateASP({
      points: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      lines: [],
      circles: [],
      angles: [],
      constraints: [],
      goal: 'triangle_abc',
    });

    expect(asp).toContain('point(a).');
    expect(asp).toContain('point(b).');
    expect(asp).toContain('point(c).');
  });

  it('should generate line predicates', () => {
    const asp = generateASP({
      points: [{ name: 'A' }, { name: 'B' }],
      lines: [{ p1: 'A', p2: 'B' }],
      circles: [],
      angles: [],
      constraints: [],
      goal: 'line_ab',
    });

    expect(asp).toContain('line(a, b).');
    expect(asp).toContain('collinear(a, b).');
  });

  it('should generate circle predicates', () => {
    const asp = generateASP({
      points: [{ name: 'O' }, { name: 'A' }],
      lines: [],
      circles: [{ center: 'O', radius: 5, passesThrough: ['A'] }],
      angles: [],
      constraints: [],
      goal: 'circle_o',
    });

    expect(asp).toContain('circle(o).');
    expect(asp).toContain('radius(o, 5).');
    expect(asp).toContain('on_circle(a, o).');
  });

  it('should generate angle predicates with measure', () => {
    const asp = generateASP({
      points: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      lines: [],
      circles: [],
      angles: [{ vertex: 'B', p1: 'A', p2: 'C', measure: 90 }],
      constraints: [],
      goal: 'right_angle',
    });

    expect(asp).toContain('angle(b, a, c).');
    expect(asp).toContain('angle_measure(b, 90).');
  });

  it('should include geometric axioms', () => {
    const asp = generateASP({
      points: [],
      lines: [],
      circles: [],
      angles: [],
      constraints: [],
      goal: 'test',
    });

    expect(asp).toContain('% Geometric axioms');
    expect(asp).toContain('determined_line');
    expect(asp).toContain('collinear');
    expect(asp).toContain('triangle');
  });

  it('should include goal constraint', () => {
    const asp = generateASP({
      points: [],
      lines: [],
      circles: [],
      angles: [],
      constraints: [],
      goal: 'my_goal',
    });

    expect(asp).toContain('% Goal: my_goal');
    expect(asp).toContain(':- not goal_satisfied.');
  });
});

describe('Geometry Solver - Answer Set Parsing', () => {
  it('should parse point atoms', () => {
    const result = parseAnswerSet(['point(a)', 'point(b)']);
    expect(result.model).toHaveProperty('point_a');
    expect(result.model).toHaveProperty('point_b');
    expect(result.construction).toContain('定义点 A');
    expect(result.construction).toContain('定义点 B');
  });

  it('should parse line atoms', () => {
    const result = parseAnswerSet(['line(a, b)']);
    expect(result.model).toHaveProperty('line_a_b');
    expect(result.construction).toContain('连接 AB');
  });

  it('should parse angle measure atoms', () => {
    const result = parseAnswerSet(['angle_measure(a, 90)']);
    expect(result.model).toHaveProperty('angle_a');
    expect(result.proof).toContain('∠A = 90°');
  });

  it('should parse parallel atoms', () => {
    const result = parseAnswerSet(['parallel(a, b, c, d)']);
    expect(result.proof).toContain('AB ∥ CD');
  });

  it('should parse perpendicular atoms', () => {
    const result = parseAnswerSet(['perpendicular(a, b, c, d)']);
    expect(result.proof).toContain('AB ⊥ CD');
  });

  it('should detect goal satisfaction', () => {
    const result = parseAnswerSet(['point(a)', 'goal_satisfied']);
    expect(result.verified).toBe(true);
  });

  it('should detect goal failure', () => {
    const result = parseAnswerSet(['point(a)']);
    expect(result.verified).toBe(false);
  });
});

describe('Geometry Solver - NL Parsing', () => {
  it('should extract point names', () => {
    const result = parseGeometryNL('三角形 ABC 中，AB 平行于 CD');
    expect(result.points?.length).toBeGreaterThanOrEqual(4);
    expect(result.points?.map(p => p.name)).toContain('A');
    expect(result.points?.map(p => p.name)).toContain('B');
  });

  it('should detect triangle', () => {
    const result = parseGeometryNL('在三角形 ABC 中');
    expect(result.lines?.length).toBe(3);
  });

  it('should detect parallel lines', () => {
    const result = parseGeometryNL('AB 平行于 CD');
    expect(result.constraints?.length).toBeGreaterThan(0);
    expect(result.constraints?.[0]).toContain('parallel');
  });

  it('should detect angle measures', () => {
    const result = parseGeometryNL('∠A = 90');
    expect(result.angles?.length).toBeGreaterThan(0);
    expect(result.angles?.[0].measure).toBe(90);
  });

  it('should detect circles', () => {
    const result = parseGeometryNL('圆 O 的半径为 5');
    expect(result.circles?.length).toBeGreaterThan(0);
    expect(result.circles?.[0].center).toBe('O');
  });
});
