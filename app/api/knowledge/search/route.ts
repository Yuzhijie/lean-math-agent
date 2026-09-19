/**
 * Knowledge graph search API
 */
import { NextRequest, NextResponse } from 'next/server';
import { searchNodes } from '@/lib/knowledge/neo4j-client';

export async function POST(request: NextRequest) {
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
