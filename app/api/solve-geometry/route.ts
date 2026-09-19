/**
 * Geometry solver API endpoint
 */
import { NextRequest, NextResponse } from 'next/server';
import { solveGeometry, parseGeometryNL, GeometryProblem } from '@/lib/geometry/clingo-solver';

export async function POST(request: NextRequest) {
  try {
    const { problem, nlDescription } = await request.json();

    let geometryProblem: GeometryProblem;

    if (problem) {
      geometryProblem = problem;
    } else if (nlDescription) {
      const parsed = parseGeometryNL(nlDescription);
      geometryProblem = {
        points: parsed.points || [],
        lines: parsed.lines || [],
        circles: parsed.circles || [],
        angles: parsed.angles || [],
        constraints: parsed.constraints || [],
        goal: 'goal_satisfied',
      };
    } else {
      return NextResponse.json(
        { error: 'Either problem or nlDescription required' },
        { status: 400 }
      );
    }

    const solution = await solveGeometry(geometryProblem);

    if (!solution) {
      return NextResponse.json({
        satisfiable: false,
        message: '问题无解或约束矛盾',
      });
    }

    return NextResponse.json({
      satisfiable: true,
      solution,
    });
  } catch (error) {
    console.error('Geometry solver error:', error);
    return NextResponse.json(
      { error: 'Geometry solving failed', details: String(error) },
      { status: 500 }
    );
  }
}
