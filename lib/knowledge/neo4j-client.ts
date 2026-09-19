/**
 * Neo4j knowledge graph client
 * Manages math concepts, theorems, and their relationships
 */
import neo4j, { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI || 'bolt://localhost:7687',
      neo4j.auth.basic(
        process.env.NEO4J_USER || 'neo4j',
        process.env.NEO4J_PASSWORD || 'password'
      )
    );
  }
  return driver;
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

// ─── Node Types ────────────────────────────────────────────────

export interface ConceptNode {
  id: string;
  name: string;
  domain: string;
  description?: string;
  difficulty?: number;
  tags: string[];
}

export interface TheoremNode {
  id: string;
  name: string;
  statement: string;
  domain: string;
  difficulty: number;
  mathlibRef?: string;
  tags: string[];
}

export interface MethodNode {
  id: string;
  name: string;
  description: string;
  domain: string;
  complexity: number;
  tags: string[];
}

export interface ProofNode {
  id: string;
  theoremId: string;
  methodId: string;
  steps: number;
  verified: boolean;
  createdAt: Date;
}

// ─── Relationship Types ────────────────────────────────────────

export type RelationType =
  | 'PREREQUISITE_OF'
  | 'USES_CONCEPT'
  | 'PROVES'
  | 'USES_METHOD'
  | 'GENERALIZES'
  | 'SPECIALIZES'
  | 'RELATED_TO';

export interface Edge {
  sourceId: string;
  targetId: string;
  relation: RelationType;
  weight?: number;
}

// ─── Query Functions ───────────────────────────────────────────

export async function runQuery(
  query: string,
  params?: Record<string, any>
): Promise<Neo4jRecord[]> {
  const session = getDriver().session();
  try {
    const result = await session.run(query, params);
    return result.records;
  } finally {
    await session.close();
  }
}

export async function createConcept(node: ConceptNode): Promise<void> {
  await runQuery(
    `MERGE (c:Concept {id: $id})
     SET c.name = $name, c.domain = $domain, c.description = $description,
         c.difficulty = $difficulty, c.tags = $tags`,
    {
      id: node.id,
      name: node.name,
      domain: node.domain,
      description: node.description || '',
      difficulty: node.difficulty || 1,
      tags: node.tags,
    }
  );
}

export async function createTheorem(node: TheoremNode): Promise<void> {
  await runQuery(
    `MERGE (t:Theorem {id: $id})
     SET t.name = $name, t.statement = $statement, t.domain = $domain,
         t.difficulty = $difficulty, t.mathlibRef = $mathlibRef, t.tags = $tags`,
    {
      id: node.id,
      name: node.name,
      statement: node.statement,
      domain: node.domain,
      difficulty: node.difficulty,
      mathlibRef: node.mathlibRef || '',
      tags: node.tags,
    }
  );
}

export async function createMethod(node: MethodNode): Promise<void> {
  await runQuery(
    `MERGE (m:Method {id: $id})
     SET m.name = $name, m.description = $description, m.domain = $domain,
         m.complexity = $complexity, m.tags = $tags`,
    {
      id: node.id,
      name: node.name,
      description: node.description,
      domain: node.domain,
      complexity: node.complexity,
      tags: node.tags,
    }
  );
}

export async function createRelationship(edge: Edge): Promise<void> {
  await runQuery(
    `MATCH (a {id: $sourceId}), (b {id: $targetId})
     MERGE (a)-[r:${edge.relation}]->(b)
     ${edge.weight ? 'SET r.weight = $weight' : ''}`,
    { sourceId: edge.sourceId, targetId: edge.targetId, weight: edge.weight || 1 }
  );
}

export async function searchNodes(
  query: string,
  options?: { domain?: string; type?: string; limit?: number }
): Promise<any[]> {
  const domainFilter = options?.domain ? `AND n.domain = $domain` : '';
  const typeFilter = options?.type ? `AND labels(n)[0] = $type` : '';
  const limit = options?.limit || 20;

  const records = await runQuery(
    `MATCH (n)
     WHERE (n.name CONTAINS $query OR n.description CONTAINS $query)
     ${domainFilter} ${typeFilter}
     RETURN n, labels(n) AS labels
     LIMIT $limit`,
    { query, domain: options?.domain, type: options?.type, limit }
  );

  return records.map((r) => ({
    ...r.get('n').properties,
    type: r.get('labels')[0],
  }));
}

export async function getNodeRelationships(
  nodeId: string,
  direction: 'in' | 'out' | 'both' = 'both'
): Promise<{ node: any; relation: string; direction: string }[]> {
  const patterns: string[] = [];
  if (direction === 'out' || direction === 'both') {
    patterns.push(`(n)-[r]->(m)`);
  }
  if (direction === 'in' || direction === 'both') {
    patterns.push(`(m)-[r]->(n)`);
  }

  const records = await runQuery(
    `MATCH (n {id: $nodeId})
     ${patterns.map((p, i) => i === 0 ? `OPTIONAL MATCH ${p}` : `OPTIONAL MATCH ${p}`).join(' ')}
     RETURN DISTINCT m, type(r) AS relation, labels(m) AS labels`,
    { nodeId }
  );

  return records
    .filter((r) => r.get('m') !== null)
    .map((r) => ({
      node: { ...r.get('m').properties, type: r.get('labels')[0] },
      relation: r.get('relation'),
      direction: direction,
    }));
}

export async function findShortestPath(
  startId: string,
  endId: string,
  maxDepth: number = 5
): Promise<string[]> {
  const records = await runQuery(
    `MATCH path = shortestPath(
       (a {id: $startId})-[*..${maxDepth}]-(b {id: $endId})
     )
     RETURN [node IN nodes(path) | node.id] AS path`,
    { startId, endId }
  );

  if (records.length === 0) return [];
  return records[0].get('path');
}

export async function getSubgraph(
  nodeId: string,
  depth: number = 2
): Promise<{ nodes: any[]; edges: Edge[] }> {
  const records = await runQuery(
    `MATCH path = (center {id: $nodeId})-[*1..${depth}]-(neighbor)
     WITH nodes(path) AS nodes, relationships(path) AS rels
     UNWIND nodes AS node
     UNWIND rels AS rel
     RETURN DISTINCT
       collect(DISTINCT {id: node.id, name: node.name, type: labels(node)[0], domain: node.domain}) AS nodes,
       collect(DISTINCT {sourceId: startNode(rel).id, targetId: endNode(rel).id, relation: type(rel)}) AS edges`,
    { nodeId }
  );

  if (records.length === 0) return { nodes: [], edges: [] };
  return {
    nodes: records[0].get('nodes'),
    edges: records[0].get('edges'),
  };
}

export async function getStats(): Promise<{
  concepts: number;
  theorems: number;
  methods: number;
  relationships: number;
}> {
  const records = await runQuery(
    `OPTIONAL MATCH (c:Concept)
     OPTIONAL MATCH (t:Theorem)
     OPTIONAL MATCH (m:Method)
     OPTIONAL MATCH ()-[r]->()
     RETURN
       count(DISTINCT c) AS concepts,
       count(DISTINCT t) AS theorems,
       count(DISTINCT m) AS methods,
       count(DISTINCT r) AS relationships`
  );

  const r = records[0];
  return {
    concepts: r.get('concepts').toNumber(),
    theorems: r.get('theorems').toNumber(),
    methods: r.get('methods').toNumber(),
    relationships: r.get('relationships').toNumber(),
  };
}

export async function recordProof(
  theoremId: string,
  methodId: string,
  steps: number,
  verified: boolean
): Promise<void> {
  await runQuery(
    `MATCH (t:Theorem {id: $theoremId}), (m:Method {id: $methodId})
     CREATE (p:Proof {id: randomUUID(), steps: $steps, verified: $verified, createdAt: datetime()})
     CREATE (p)-[:PROVES]->(t)
     CREATE (p)-[:USES_METHOD]->(m)`,
    { theoremId, methodId, steps, verified }
  );
}

// ─── Seed Data ─────────────────────────────────────────────────

export async function seedMathConcepts(): Promise<void> {
  const concepts: ConceptNode[] = [
    { id: 'natural_numbers', name: '自然数', domain: 'number_theory', difficulty: 1, tags: ['基础'] },
    { id: 'integers', name: '整数', domain: 'number_theory', difficulty: 1, tags: ['基础'] },
    { id: 'rational_numbers', name: '有理数', domain: 'number_theory', difficulty: 2, tags: ['基础'] },
    { id: 'real_numbers', name: '实数', domain: 'analysis', difficulty: 2, tags: ['基础'] },
    { id: 'induction', name: '数学归纳法', domain: 'proof_methods', difficulty: 2, tags: ['证明方法'] },
    { id: 'contradiction', name: '反证法', domain: 'proof_methods', difficulty: 2, tags: ['证明方法'] },
    { id: 'contrapositive', name: '逆否命题', domain: 'proof_methods', difficulty: 2, tags: ['证明方法'] },
    { id: 'polynomials', name: '多项式', domain: 'algebra', difficulty: 2, tags: ['代数'] },
    { id: 'equations', name: '方程', domain: 'algebra', difficulty: 1, tags: ['代数'] },
    { id: 'inequalities', name: '不等式', domain: 'algebra', difficulty: 2, tags: ['代数'] },
    { id: 'functions', name: '函数', domain: 'analysis', difficulty: 2, tags: ['分析'] },
    { id: 'limits', name: '极限', domain: 'analysis', difficulty: 3, tags: ['分析'] },
    { id: 'derivatives', name: '导数', domain: 'analysis', difficulty: 3, tags: ['分析'] },
    { id: 'integrals', name: '积分', domain: 'analysis', difficulty: 3, tags: ['分析'] },
    { id: 'sets', name: '集合', domain: 'set_theory', difficulty: 1, tags: ['基础'] },
    { id: 'graphs', name: '图论', domain: 'combinatorics', difficulty: 3, tags: ['组合'] },
    { id: 'permutations', name: '排列组合', domain: 'combinatorics', difficulty: 2, tags: ['组合'] },
    { id: 'probability', name: '概率', domain: 'combinatorics', difficulty: 3, tags: ['组合'] },
    { id: 'vectors', name: '向量', domain: 'linear_algebra', difficulty: 2, tags: ['线性代数'] },
    { id: 'matrices', name: '矩阵', domain: 'linear_algebra', difficulty: 3, tags: ['线性代数'] },
  ];

  for (const c of concepts) {
    await createConcept(c);
  }

  const edges: Edge[] = [
    { sourceId: 'natural_numbers', targetId: 'integers', relation: 'GENERALIZES' },
    { sourceId: 'integers', targetId: 'rational_numbers', relation: 'GENERALIZES' },
    { sourceId: 'rational_numbers', targetId: 'real_numbers', relation: 'GENERALIZES' },
    { sourceId: 'induction', targetId: 'natural_numbers', relation: 'USES_CONCEPT' },
    { sourceId: 'equations', targetId: 'polynomials', relation: 'USES_CONCEPT' },
    { sourceId: 'limits', targetId: 'functions', relation: 'PREREQUISITE_OF' },
    { sourceId: 'derivatives', targetId: 'limits', relation: 'PREREQUISITE_OF' },
    { sourceId: 'integrals', targetId: 'derivatives', relation: 'PREREQUISITE_OF' },
    { sourceId: 'matrices', targetId: 'vectors', relation: 'PREREQUISITE_OF' },
  ];

  for (const e of edges) {
    await createRelationship(e);
  }
}
