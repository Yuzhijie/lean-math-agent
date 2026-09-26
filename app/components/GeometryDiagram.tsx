'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Ruler, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

interface GeometryPoint {
  name: string;
  x: number;
  y: number;
}

interface GeometryLine {
  p1: string;
  p2: string;
}

interface GeometryCircle {
  center: string;
  radius: number;
}

interface GeometryDiagramProps {
  points: GeometryPoint[];
  lines: GeometryLine[];
  circles?: GeometryCircle[];
  labels?: Record<string, string>;
  width?: number;
  height?: number;
}

export function GeometryDiagram({
  points,
  lines,
  circles = [],
  labels = {},
  width = 500,
  height = 400,
}: GeometryDiagramProps) {
  const { tr } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [hoveredPoint, setHoveredPoint] = useState<string | null>(null);

  const getPoint = (name: string) => points.find(p => p.name === name);

  return (
    <Card className="bg-slate-800/50 border-slate-700">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-white flex items-center gap-2 text-base">
            <Ruler className="h-4 w-4 text-blue-500" />
            {tr('几何图形', 'Geometry diagram')}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(z => Math.min(z * 1.2, 3))}>
              <ZoomIn className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(z => Math.max(z / 1.2, 0.5))}>
              <ZoomOut className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(1)}>
              <RotateCcw className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-2">
        <div className="bg-slate-900/50 rounded-lg border border-slate-700 overflow-hidden">
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="select-none"
          >
            <defs>
              <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
              </marker>
            </defs>

            <g transform={`scale(${zoom}) translate(${(1 - zoom) * width / 2}, ${(1 - zoom) * height / 2})`}>
              {/* Grid */}
              <g opacity="0.1">
                {Array.from({ length: Math.floor(width / 40) + 1 }, (_, i) => (
                  <line key={`gv${i}`} x1={i * 40} y1={0} x2={i * 40} y2={height} stroke="#64748b" strokeWidth="0.5" />
                ))}
                {Array.from({ length: Math.floor(height / 40) + 1 }, (_, i) => (
                  <line key={`gh${i}`} x1={0} y1={i * 40} x2={width} y2={i * 40} stroke="#64748b" strokeWidth="0.5" />
                ))}
              </g>

              {/* Circles */}
              {circles.map((circle, i) => {
                const center = getPoint(circle.center);
                if (!center) return null;
                return (
                  <circle
                    key={`circle-${i}`}
                    cx={center.x}
                    cy={center.y}
                    r={circle.radius}
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth="1.5"
                    strokeDasharray="4 2"
                    opacity="0.7"
                  />
                );
              })}

              {/* Lines */}
              {lines.map((line, i) => {
                const p1 = getPoint(line.p1);
                const p2 = getPoint(line.p2);
                if (!p1 || !p2) return null;
                return (
                  <line
                    key={`line-${i}`}
                    x1={p1.x} y1={p1.y}
                    x2={p2.x} y2={p2.y}
                    stroke="#e2e8f0"
                    strokeWidth="1.5"
                    opacity="0.8"
                  />
                );
              })}

              {/* Points */}
              {points.map((point) => (
                <g
                  key={point.name}
                  onMouseEnter={() => setHoveredPoint(point.name)}
                  onMouseLeave={() => setHoveredPoint(null)}
                  className="cursor-pointer"
                >
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={hoveredPoint === point.name ? 6 : 4}
                    fill={hoveredPoint === point.name ? '#f59e0b' : '#ef4444'}
                    stroke="white"
                    strokeWidth="1.5"
                  />
                  <text
                    x={point.x + 10}
                    y={point.y - 8}
                    fill="#f8fafc"
                    fontSize="14"
                    fontWeight="bold"
                  >
                    {labels[point.name] || point.name}
                  </text>
                  {hoveredPoint === point.name && (
                    <text
                      x={point.x + 10}
                      y={point.y + 18}
                      fill="#94a3b8"
                      fontSize="10"
                    >
                      ({point.x.toFixed(0)}, {point.y.toFixed(0)})
                    </text>
                  )}
                </g>
              ))}

              {/* Labels on lines */}
              {lines.map((line, i) => {
                const p1 = getPoint(line.p1);
                const p2 = getPoint(line.p2);
                if (!p1 || !p2) return null;
                const mx = (p1.x + p2.x) / 2;
                const my = (p1.y + p2.y) / 2;
                const len = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
                const labelKey = `${line.p1}${line.p2}`;
                if (!labels[labelKey]) return null;
                return (
                  <text
                    key={`label-${i}`}
                    x={mx}
                    y={my - 8}
                    fill="#94a3b8"
                    fontSize="11"
                    textAnchor="middle"
                  >
                    {labels[labelKey]}
                  </text>
                );
              })}
            </g>
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
