/**
 * Knowledge graph subgraph API
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSubgraph, getNodeRelationships } from '@/lib/knowledge/neo4j-client';

export async function POST(request: NextRequest) {
  try {
    const { nodeId, depth, includeRelationships } = await request.json();

    if (!nodeId) {
      return NextResponse.json({ error: 'nodeId required' }, { status: 400 });
    }

    if (includeRelationships) {
      const rels = await getNodeRelationships(nodeId);
      return NextResponse.json({ relationships: rels });
    }

    const subgraph = await getSubgraph(nodeId, depth || 2);
    return NextResponse.json(subgraph);
  } catch (error) {
    console.error('Graph query error:', error);
    return NextResponse.json(
      { error: 'Graph query failed', details: String(error) },
      { status: 500 }
    );
  }
}
