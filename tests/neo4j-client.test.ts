/**
 * Tests for Neo4j knowledge graph client (mocked)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock neo4j-driver
vi.mock('neo4j-driver', () => ({
  default: {
    driver: vi.fn(() => mockDriver),
    auth: { basic: vi.fn() },
  },
  driver: vi.fn(() => mockDriver),
  auth: { basic: vi.fn() },
}));

const mockSession = {
  run: vi.fn(),
  close: vi.fn(),
};

const mockDriver = {
  session: vi.fn(() => mockSession),
  close: vi.fn(),
};

describe('Knowledge Graph Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create concept nodes', async () => {
    mockSession.run.mockResolvedValue({ records: [] });

    // Dynamic import to use the mocked module
    const { createConcept } = await import('../lib/knowledge/neo4j-client');
    await createConcept({
      id: 'test_concept',
      name: 'Test Concept',
      domain: 'algebra',
      difficulty: 2,
      tags: ['test'],
    });

    expect(mockSession.run).toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should create theorem nodes', async () => {
    mockSession.run.mockResolvedValue({ records: [] });

    const { createTheorem } = await import('../lib/knowledge/neo4j-client');
    await createTheorem({
      id: 'test_theorem',
      name: 'Test Theorem',
      statement: 'For all n, n + 0 = n',
      domain: 'number_theory',
      difficulty: 1,
      tags: ['basic'],
    });

    expect(mockSession.run).toHaveBeenCalled();
  });

  it('should create method nodes', async () => {
    mockSession.run.mockResolvedValue({ records: [] });

    const { createMethod } = await import('../lib/knowledge/neo4j-client');
    await createMethod({
      id: 'induction',
      name: 'Mathematical Induction',
      description: 'Prove by induction on n',
      domain: 'proof_methods',
      complexity: 2,
      tags: ['induction'],
    });

    expect(mockSession.run).toHaveBeenCalled();
  });

  it('should create relationships', async () => {
    mockSession.run.mockResolvedValue({ records: [] });

    const { createRelationship } = await import('../lib/knowledge/neo4j-client');
    await createRelationship({
      sourceId: 'natural_numbers',
      targetId: 'induction',
      relation: 'USES_CONCEPT',
      weight: 1,
    });

    expect(mockSession.run).toHaveBeenCalled();
  });

  it('should search nodes', async () => {
    mockSession.run.mockResolvedValue({
      records: [
        {
          get: (key: string) => {
            if (key === 'n') return { properties: { id: 'test', name: 'Test' } };
            if (key === 'labels') return ['Concept'];
            return null;
          },
        },
      ],
    });

    const { searchNodes } = await import('../lib/knowledge/neo4j-client');
    const results = await searchNodes('test', { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('Concept');
  });

  it('should get subgraph', async () => {
    mockSession.run.mockResolvedValue({
      records: [
        {
          get: (key: string) => {
            if (key === 'nodes') return [{ id: 'a', name: 'A' }];
            if (key === 'edges') return [];
            return null;
          },
        },
      ],
    });

    const { getSubgraph } = await import('../lib/knowledge/neo4j-client');
    const result = await getSubgraph('a', 2);

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it('should get stats', async () => {
    mockSession.run.mockResolvedValue({
      records: [
        {
          get: (key: string) => ({
            toNumber: () => {
              const map: Record<string, number> = {
                concepts: 10,
                theorems: 5,
                methods: 3,
                relationships: 20,
              };
              return map[key];
            },
          }),
        },
      ],
    });

    const { getStats } = await import('../lib/knowledge/neo4j-client');
    const stats = await getStats();

    expect(stats.concepts).toBe(10);
    expect(stats.theorems).toBe(5);
    expect(stats.methods).toBe(3);
    expect(stats.relationships).toBe(20);
  });
});
