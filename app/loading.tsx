import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function Loading() {
  return (
    <div className="relative z-10 min-h-screen">
      {/* Header skeleton */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Skeleton className="h-6 w-14 rounded-full" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </div>
        </div>
      </header>

      {/* Content skeleton */}
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-6">
        {/* Problem card skeleton */}
        <Card className="animate-pulse">
          <CardHeader className="pb-3">
            <Skeleton className="h-5 w-16" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-20 w-full rounded-md" />
            <div className="flex gap-2">
              <Skeleton className="h-9 w-24 rounded-md" />
              <Skeleton className="h-9 w-24 rounded-md" />
            </div>
          </CardContent>
        </Card>

        {/* Results skeleton */}
        <div className="space-y-4">
          <div className="flex gap-1">
            <Skeleton className="h-9 w-20 rounded-md" />
            <Skeleton className="h-9 w-20 rounded-md" />
            <Skeleton className="h-9 w-20 rounded-md" />
          </div>
          <Card className="animate-pulse">
            <CardContent className="p-6 space-y-4">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
