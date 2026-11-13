/**
 * Knowledge graph search API
 */
import { NextRequest, NextResponse } from 'next/server';
import { searchNodes } from '@/lib/knowledge/neo4j-client';
import { frozenRoute } from '@/lib/scope';

async function handlePOST(request: NextRequest) {
  try {
    const { query, domain, type, limit } = await request.json();

    if (!query) {
      return NextResponse.json({ error: 'Query required' }, { status: 400 });
    }

    const results = await searchNodes(query, { domain, type, limit });
    return NextResponse.json({ results });
  } catch (error) {
    console.error('Knowledge search error:', error);
    return NextResponse.json(
      { error: 'Search failed', details: String(error) },
      { status: 500 }
    );
  }
}

// Frozen (lib/scope.ts, docs/SCOPE.md): 404 unless THAW names "knowledge".
export const POST = frozenRoute('knowledge', handlePOST);
