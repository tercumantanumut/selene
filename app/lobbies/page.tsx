"use client";

/**
 * Captain's lobby list — `/lobbies`.
 *
 * Top-level overview of the captain's Solo Story Mode lobbies. SPEC §6
 * mandates a status filter and a paginated list ordered by `updated_at`
 * desc. Click row → `/lobbies/:id`. CTA → `/lobbies/new`.
 *
 * Render strategy: client component using `useLobbyList` (a thin
 * fetch+useEffect+useState hook from `lib/lobbies/client/hooks.ts`). No
 * TanStack Query / SWR (HARD CONSTRAINT in SPEC §3).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Plus,
  Users,
  ListChecks,
  CheckCircle2,
  Hammer,
  Search,
  AlertCircle,
} from "lucide-react";

import { Shell } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { useLobbyList } from "@/lib/lobbies/client/hooks";
import type { LobbyStatus } from "@/lib/lobbies/types";
import type { Lobby } from "@/lib/db/sqlite-lobbies-schema";

// ─── Status pill config ────────────────────────────────────────────────────

const STATUS_FILTER_TABS: Array<{ key: LobbyStatus | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "roster", label: "Roster" },
  { key: "planning", label: "Planning" },
  { key: "rolling", label: "Rolling" },
  { key: "review", label: "Review" },
  { key: "completed", label: "Completed" },
  { key: "aborted", label: "Aborted" },
];

const STATUS_BADGE: Record<LobbyStatus, { label: string; className: string }> = {
  roster:    { label: "Roster",    className: "bg-terminal-amber/15 text-terminal-amber border-terminal-amber/40" },
  planning:  { label: "Planning",  className: "bg-blue-500/15 text-blue-600 border-blue-500/30" },
  rolling:   { label: "Rolling",   className: "bg-terminal-green/15 text-terminal-green border-terminal-green/40" },
  review:    { label: "Review",    className: "bg-purple-500/15 text-purple-600 border-purple-500/30" },
  completed: { label: "Completed", className: "bg-terminal-muted/15 text-terminal-muted border-terminal-muted/40" },
  aborted:   { label: "Aborted",   className: "bg-red-500/15 text-red-600 border-red-500/30" },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function parseAsUTC(dateStr: string): Date {
  const normalized =
    dateStr.includes("Z") || dateStr.includes("+") || dateStr.includes("-", 10)
      ? dateStr
      : dateStr.replace(" ", "T") + "Z";
  return new Date(normalized);
}

function formatRelative(dateStr: string, now: Date): string {
  const date = parseAsUTC(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return date.toLocaleDateString();
}

// ─── Components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: LobbyStatus }) {
  const cfg = STATUS_BADGE[status];
  return (
    <Badge
      variant="outline"
      className={cn("font-mono text-xs", cfg.className)}
    >
      {cfg.label}
    </Badge>
  );
}

function LobbyRow({ lobby, now }: { lobby: Lobby; now: Date }) {
  return (
    <Link
      href={`/lobbies/${lobby.id}`}
      className={cn(
        "group flex items-start gap-3 rounded-lg border border-terminal-border/40 bg-terminal-cream/40 p-3 transition-all duration-150",
        "hover:bg-terminal-cream/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green focus-visible:ring-offset-1",
      )}
    >
      <div className="mt-0.5 shrink-0 text-terminal-muted">
        <ListChecks className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="font-mono text-sm font-medium text-terminal-dark truncate">
            {lobby.title || "Untitled lobby"}
          </p>
          <StatusBadge status={lobby.status} />
        </div>
        <p className="mt-0.5 font-mono text-xs text-terminal-muted/90 line-clamp-2">
          {lobby.goal}
        </p>
        <p className="mt-1 font-mono text-[11px] text-terminal-muted/70">
          {formatRelative(lobby.updatedAt, now)}
        </p>
      </div>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-terminal-border/40 bg-terminal-cream/30 px-6 py-10 text-center">
      <Users className="h-8 w-8 text-terminal-muted" />
      <div>
        <p className="font-mono text-sm font-medium text-terminal-dark">
          No lobbies yet
        </p>
        <p className="mt-1 font-mono text-xs text-terminal-muted">
          Spin up a roster, draft a plan, and let your crew roll on the cards.
        </p>
      </div>
      <Button asChild size="sm" className="font-mono">
        <Link href="/lobbies/new">
          <Plus className="mr-1.5 h-4 w-4" />
          New lobby
        </Link>
      </Button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-3 rounded-lg border border-terminal-border/40 bg-terminal-cream/40 p-3"
        >
          <Skeleton className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function LobbiesListPage() {
  const router = useRouter();
  const [activeFilter, setActiveFilter] = useState<LobbyStatus | "all">("all");
  const [now, setNow] = useState(() => new Date());

  // Tick the relative-time clock every minute so timestamps stay fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    document.title = "Lobbies — Selene";
    return () => {
      document.title = "Selene";
    };
  }, []);

  const params = useMemo(
    () =>
      activeFilter === "all"
        ? { limit: 50 }
        : { status: activeFilter, limit: 50 },
    [activeFilter],
  );

  const { data, loading, error, refetch } = useLobbyList(params);

  const lobbies = data?.lobbies ?? [];

  // Stat tiles: total, active (roster|planning|rolling|review), completed.
  const stats = useMemo(() => {
    const total = lobbies.length;
    const active = lobbies.filter((l) =>
      ["roster", "planning", "rolling", "review"].includes(l.status),
    ).length;
    const completed = lobbies.filter((l) => l.status === "completed").length;
    return { total, active, completed };
  }, [lobbies]);

  return (
    <Shell>
      <ScrollArea className="h-full">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-6">
          {/* ── Header ── */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="font-mono text-2xl font-bold text-terminal-dark">
                Lobbies
              </h1>
              <p className="font-mono text-sm text-terminal-muted mt-0.5">
                Run a multi-agent crew across roster, planning, rolling, and
                review.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refetch()}
                disabled={loading}
                className="font-mono"
              >
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => router.push("/lobbies/new")}
                className="font-mono"
              >
                <Plus className="mr-1.5 h-4 w-4" />
                New lobby
              </Button>
            </div>
          </div>

          {/* ── Stat tiles (only when we have data) ── */}
          {!loading && data ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile
                icon={Users}
                label="Total lobbies"
                value={stats.total}
                accent="muted"
              />
              <StatTile
                icon={Hammer}
                label="Active"
                value={stats.active}
                accent="green"
              />
              <StatTile
                icon={CheckCircle2}
                label="Completed"
                value={stats.completed}
                accent="amber"
              />
            </div>
          ) : null}

          {/* ── Filter tabs ── */}
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-terminal-border/40 bg-terminal-cream/30 p-1">
            {STATUS_FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveFilter(tab.key)}
                className={cn(
                  "rounded-md px-3 py-1.5 font-mono text-xs transition-colors",
                  activeFilter === tab.key
                    ? "bg-terminal-cream text-terminal-dark shadow-sm"
                    : "text-terminal-muted hover:text-terminal-dark hover:bg-terminal-cream/60",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── Body ── */}
          {error ? (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
              <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-mono text-sm text-red-600">
                  Failed to load lobbies
                </p>
                <p className="font-mono text-xs text-terminal-muted/80 mt-0.5">
                  {error}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refetch()}
                className="font-mono"
              >
                Retry
              </Button>
            </div>
          ) : null}

          {loading ? (
            <ListSkeleton />
          ) : lobbies.length === 0 && !error ? (
            <EmptyState />
          ) : (
            <Card className="bg-terminal-cream/30 border-terminal-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="font-mono text-sm font-semibold text-terminal-dark flex items-center gap-2">
                  <Search className="h-4 w-4 text-terminal-muted" />
                  Lobbies
                  <span className="ml-auto font-mono text-xs font-normal text-terminal-muted">
                    {lobbies.length}
                    {data?.nextCursor ? "+" : ""} shown
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {lobbies.map((lobby) => (
                  <LobbyRow key={lobby.id} lobby={lobby} now={now} />
                ))}
                {data?.nextCursor ? (
                  <p className="font-mono text-xs text-terminal-muted/70 text-center py-2">
                    More lobbies available — pagination is wired in a later
                    sprint.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
    </Shell>
  );
}

// ─── Sub: stat tile (kept here for cohesion) ───────────────────────────────

function StatTile({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  accent: "green" | "amber" | "muted";
}) {
  const accentClass =
    accent === "green"
      ? "text-terminal-green"
      : accent === "amber"
        ? "text-terminal-amber"
        : "text-terminal-muted";

  return (
    <Card className="bg-terminal-cream/40 border-terminal-border/50">
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "mt-0.5 rounded-md p-2 bg-terminal-cream/60 border border-terminal-border/40",
              accentClass,
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <p className="font-mono text-xs text-terminal-muted">{label}</p>
            <p className="font-mono text-2xl font-bold text-terminal-dark leading-tight">
              {value}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

