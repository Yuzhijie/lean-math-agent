/**
 * Knowledge graph stats API
 */
import { NextResponse } from 'next/server';
import { getStats, seedMathConcepts } from '@/lib/knowledge/neo4j-client';
import { frozenRoute } from '@/lib/scope';

async function handleGET() {
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

async function handlePOST() {
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

// Frozen (lib/scope.ts, docs/SCOPE.md): 404 unless THAW names "knowledge".
export const GET = frozenRoute('knowledge', handleGET);
export const POST = frozenRoute('knowledge', handlePOST);
