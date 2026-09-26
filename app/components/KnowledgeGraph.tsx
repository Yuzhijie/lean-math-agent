'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Search, ZoomIn, ZoomOut, RotateCcw, Network } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

interface GraphNode {
  id: string;
  name: string;
  type: string;
  domain: string;
  x?: number;
  y?: number;
}

interface GraphEdge {
  sourceId: string;
  targetId: string;
  relation: string;
}

interface KnowledgeGraphProps {
  initialNodeId?: string;
}

export function KnowledgeGraph({ initialNodeId }: KnowledgeGraphProps) {
  const { tr } = useI18n();
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);

  const loadSubgraph = useCallback(async (nodeId: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/knowledge/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId, depth: 2 }),
      });
      const data = await res.json();
      setNodes(data.nodes || []);
      setEdges(data.edges || []);
    } catch (error) {
      console.error('Failed to load graph:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/knowledge/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, limit: 5 }),
      });
      const { results } = await res.json();
      if (results.length > 0) {
        loadSubgraph(results[0].id);
        setSelectedNode(results[0]);
      }
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialNodeId) {
      loadSubgraph(initialNodeId);
    }
  }, [initialNodeId, loadSubgraph]);

  const domainColors: Record<string, string> = {
    number_theory: '#f59e0b',
    algebra: '#3b82f6',
    analysis: '#10b981',
    combinatorics: '#8b5cf6',
    set_theory: '#ef4444',
    linear_algebra: '#06b6d4',
    proof_methods: '#ec4899',
  };

  return (
    <Card className="bg-slate-800/50 border-slate-700">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-white flex items-center gap-2">
            <Network className="h-5 w-5 text-amber-500" />
            {tr('知识图谱', 'Knowledge graph')}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setZoom(z => z * 1.2)}>
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setZoom(z => z / 1.2)}>
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setZoom(1)}>
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex gap-2 mt-2">
          <Input
            placeholder={tr('搜索概念、定理...', 'Search concepts, theorems...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="bg-slate-900/50 border-slate-600 text-white"
          />
          <Button onClick={handleSearch} disabled={loading} className="bg-amber-600 hover:bg-amber-700">
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative h-[400px] bg-slate-900/50 rounded-lg overflow-hidden border border-slate-700">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-900/50">
              <div className="animate-spin h-8 w-8 border-2 border-amber-500 border-t-transparent rounded-full" />
            </div>
          )}
          <svg
            ref={svgRef}
            className="w-full h-full"
            viewBox="0 0 800 400"
            style={{ transform: `scale(${zoom})` }}
          >
            {/* Edges */}
            {edges.map((edge, i) => {
              const source = nodes.find(n => n.id === edge.sourceId);
              const target = nodes.find(n => n.id === edge.targetId);
              if (!source || !target) return null;
              const sx = source.x ?? 400;
              const sy = source.y ?? 200;
              const tx = target.x ?? 400;
              const ty = target.y ?? 200;
              return (
                <g key={i}>
                  <line
                    x1={sx} y1={sy} x2={tx} y2={ty}
                    stroke="#475569" strokeWidth="1" strokeOpacity="0.6"
                  />
                  <text
                    x={(sx + tx) / 2} y={(sy + ty) / 2 - 5}
                    fill="#94a3b8" fontSize="10" textAnchor="middle"
                  >
                    {edge.relation}
                  </text>
                </g>
              );
            })}
            {/* Nodes */}
            {nodes.map((node, i) => {
              const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1);
              const radius = 150;
              const cx = 400 + radius * Math.cos(angle);
              const cy = 200 + radius * Math.sin(angle);
              const color = domainColors[node.domain] || '#6b7280';
              const isSelected = selectedNode?.id === node.id;
              return (
                <g
                  key={node.id}
                  onClick={() => {
                    setSelectedNode(node);
                    loadSubgraph(node.id);
                  }}
                  className="cursor-pointer"
                >
                  <circle
                    cx={cx} cy={cy} r={isSelected ? 24 : 18}
                    fill={color} fillOpacity={isSelected ? 0.3 : 0.15}
                    stroke={color} strokeWidth={isSelected ? 3 : 2}
                  />
                  <text
                    x={cx} y={cy + 4}
                    fill="white" fontSize="11" textAnchor="middle"
                    fontWeight={isSelected ? 'bold' : 'normal'}
                  >
                    {node.name.length > 6 ? node.name.slice(0, 5) + '…' : node.name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        {selectedNode && (
          <div className="mt-4 p-3 bg-slate-900/50 rounded-lg border border-slate-700">
            <div className="flex items-center gap-2 mb-2">
              <Badge style={{ backgroundColor: domainColors[selectedNode.domain] }}>
                {selectedNode.domain}
              </Badge>
              <span className="text-white font-medium">{selectedNode.name}</span>
              <Badge variant="outline" className="text-slate-400 border-slate-600">
                {selectedNode.type}
              </Badge>
            </div>
            <p className="text-slate-400 text-sm">
              ID: {selectedNode.id}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
