/**
 * Knowledge graph stats API
 */
import { NextResponse } from 'next/server';
import { getStats, seedMathConcepts } from '@/lib/knowledge/neo4j-client';

export async function GET() {
  try {
    const stats = await getStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    return NextResponse.json(
      { error: 'Failed to get stats', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    await seedMathConcepts();
    const stats = await getStats();
    return NextResponse.json({ message: 'Seeded successfully', stats });
  } catch (error) {
    console.error('Seed error:', error);
    return NextResponse.json(
      { error: 'Seed failed', details: String(error) },
      { status: 500 }
    );
  }
}
