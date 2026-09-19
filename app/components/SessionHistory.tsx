"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MathText } from "./MathText";
import { cn } from "@/lib/utils";
import {
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileText,
  BookOpen,
  FlaskConical,
  Trash2,
  Search,
  SearchX,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

interface SessionSummary {
  id: string;
  problem_text: string;
  pipeline_stage: string;
  build_status: string;
  created_at: number;
  updated_at: number;
  theorem_name: string | null;
  has_methods: boolean;
  has_steps: boolean;
  has_nl_solution: boolean;
  has_lean_attempt: boolean;
}

interface PaginatedResponse {
  sessions: SessionSummary[];
  total: number;
  page: number;
  per_page: number;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoadSession: (sessionId: string) => void;
  /** Changes to this value trigger a refresh of the session list */
  refreshKey?: string | null;
};

const PER_PAGE = 20;

// ── Relative time formatting ──────────────────────────────────────────

function relativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;

  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Pipeline stage badge ──────────────────────────────────────────────

const stageConfig: Record<
  string,
  { label: string; variant: "success" | "destructive" | "warning" | "secondary" | "default" }
> = {
  idle: { label: "初始", variant: "secondary" },
  complete: { label: "完成", variant: "success" },
  failed: { label: "失败", variant: "destructive" },
  solving: { label: "求解中", variant: "default" },
  computing: { label: "计算中", variant: "default" },
  enumerating: { label: "枚举中", variant: "default" },
  planning: { label: "规划中", variant: "default" },
};

// ── Component ─────────────────────────────────────────────────────────

export function SessionHistory({ open, onOpenChange, onLoadSession, refreshKey }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Debounce search input (300ms)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      setPage(1); // Reset to page 1 on new search
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchQuery]);

  // Fetch sessions when open, refreshKey, page, or debouncedQuery changes
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("per_page", String(PER_PAGE));
        if (debouncedQuery) params.set("q", debouncedQuery);

        const res = await fetch(`/api/sessions?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        // Handle both paginated response and legacy flat array
        if (Array.isArray(data)) {
          if (!cancelled) {
            setSessions(data as SessionSummary[]);
            setTotal((data as SessionSummary[]).length);
          }
        } else {
          const paginated = data as PaginatedResponse;
          if (!cancelled) {
            setSessions(paginated.sessions);
            setTotal(paginated.total);
          }
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [open, refreshKey, page, debouncedQuery]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const handleLoad = (id: string) => {
    onLoadSession(id);
    onOpenChange(false);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingId(id);
    try {
      const res = await fetch(`/api/session/${id}`, { method: "DELETE" });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setTotal((prev) => prev - 1);
      }
    } catch {
      // ignore delete failure
    } finally {
      setDeletingId(null);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm("确定要清空所有历史记录吗？此操作不可撤销。")) return;
    try {
      const res = await fetch("/api/sessions", { method: "DELETE" });
      if (res.ok) {
        setSessions([]);
        setTotal(0);
      }
    } catch {
      // ignore
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="p-0 w-[340px] sm:max-w-[340px]">
        <SheetHeader className="px-6 pt-6 pb-4">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-primary" />
              历史记录
            </SheetTitle>
            {total > 0 && !loading && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearAll}
                className="text-xs text-muted-foreground hover:text-destructive gap-1 h-7"
              >
                <Trash2 className="h-3 w-3" />
                清空
              </Button>
            )}
          </div>
          <SheetDescription>
            浏览并恢复之前的求解会话{total > 0 && ` (${total} 条)`}
          </SheetDescription>
        </SheetHeader>

        {/* Search input */}
        {(total > 0 || searchQuery) && !loading && (
          <div className="px-4 pb-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索历史..."
                className="pl-8 h-8 text-xs"
              />
            </div>
          </div>
        )}

        <ScrollArea className="h-[calc(100vh-220px)] px-3 pb-3">
          {/* Loading */}
          {loading && (
            <div className="space-y-3 px-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-lg border border-border/60 p-3 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <XCircle className="h-8 w-8 text-destructive mb-3" />
              <p className="text-sm font-medium text-destructive">加载失败</p>
              <p className="mt-1 text-xs text-muted-foreground">{error}</p>
            </div>
          )}

          {/* Empty */}
          {!loading && !error && total === 0 && !searchQuery && (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/40 mb-3">
                <FileText className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">
                暂无历史记录
              </p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                求解问题后，会话将自动保存
              </p>
            </div>
          )}

          {/* No search results */}
          {!loading && !error && searchQuery && sessions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <SearchX className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">
                未找到匹配的会话
              </p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                尝试其他搜索关键词
              </p>
            </div>
          )}

          {/* Session list */}
          {!loading && !error && sessions.length > 0 && (
            <div className="space-y-2 px-1">
              {sessions.map((session) => {
                const stage = stageConfig[session.pipeline_stage] ?? {
                  label: session.pipeline_stage,
                  variant: "secondary" as const,
                };
                const isDeleting = deletingId === session.id;

                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleLoad(session.id)}
                    className={cn(
                      "w-full text-left rounded-lg border border-border/60 p-3",
                      "transition-all duration-200",
                      "hover:bg-accent/10 hover:border-primary/30",
                      "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
                      "group relative",
                    )}
                  >
                    {/* Delete button */}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => handleDelete(session.id, e)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleDelete(session.id, e as unknown as React.MouseEvent);
                        }
                      }}
                      className={cn(
                        "absolute top-2 right-2 p-1 rounded-md",
                        "opacity-0 group-hover:opacity-100 transition-opacity",
                        "hover:bg-destructive/10 text-muted-foreground hover:text-destructive",
                        isDeleting && "opacity-100 animate-pulse",
                      )}
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>

                    {/* Problem text */}
                    <p className="text-sm leading-relaxed text-card-foreground line-clamp-2 mb-2 pr-6">
                      <MathText text={session.problem_text} />
                    </p>

                    {/* Meta row */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {relativeTime(session.created_at)}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {session.has_nl_solution && (
                          <span title="有解答"><BookOpen className="h-3 w-3 text-primary/60" /></span>
                        )}
                        {session.has_lean_attempt && (
                          <span title="有 Lean 证明"><FlaskConical className="h-3 w-3 text-primary/60" /></span>
                        )}
                        <Badge variant={stage.variant} className="text-[10px] gap-0.5">
                          {stage.label}
                        </Badge>
                        {session.build_status === "ok" && (
                          <CheckCircle2 className="h-3 w-3 text-success" />
                        )}
                        {session.build_status === "fail" && (
                          <XCircle className="h-3 w-3 text-destructive" />
                        )}
                        {session.build_status === "unavailable" && (
                          <AlertTriangle className="h-3 w-3 text-warning" />
                        )}
                      </div>
                    </div>

                    {session.theorem_name && (
                      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground/70 truncate">
                        {session.theorem_name}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {/* Pagination controls */}
        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-border">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5 mr-1" />
              上一页
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
              <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
