"use client";

/**
 * `/lobbies/[id]` — captain's lobby workspace shell.
 *
 * Houses the full Solo Story flow as scroll-anchored sections (NOT a wizard
 * with hidden tabs — SPEC §3 #11 mandates progressive reveal). Sprint 5
 * lands the SHELL: data fetch, phase progress rail, and section placeholders
 * the later sprints fill in:
 *   - Sprint 6 → RosterSection (this page renders only the seat count today).
 *   - Sprint 7 → PlanningSection + RollingSection (Kanban + DnD).
 *   - Sprint 8 → ReviewSection (live run embed + approve/reject/retry).
 *   - Sprint 9 → SynthesisSection (final artifact).
 *
 * Server-authoritative data lives on the server; this page calls
 * `useLobbyDetail` (fetch + useEffect) and feeds the cross-component UI
 * coordinator store (`useSoloStoryUiStore`) so other components on the page
 * can subscribe selectively (selected card, expanded transcripts, etc.).
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Users,
  ClipboardList,
  Activity,
  CheckCircle2,
  Sparkles,
} from "lucide-react";

import { Shell } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { useLobbyDetail } from "@/lib/lobbies/client/hooks";
import {
  useSoloStoryUiStore,
  useSectionControls,
  type LobbyPhaseSection,
} from "@/lib/stores/solo-story-ui-store";
import type { LobbyStatus } from "@/lib/lobbies/types";

// ─── Phase-rail config ─────────────────────────────────────────────────────

const PHASES: Array<{
  key: LobbyPhaseSection;
  label: string;
  icon: React.ElementType;
  /** Lobby status that *enters* this phase. */
  enterStatus: LobbyStatus;
}> = [
  { key: "roster",     label: "Roster",     icon: Users,         enterStatus: "roster" },
  { key: "planning",   label: "Planning",   icon: ClipboardList, enterStatus: "planning" },
  { key: "rolling",    label: "Rolling",    icon: Activity,      enterStatus: "rolling" },
  { key: "review",     label: "Review",     icon: CheckCircle2,  enterStatus: "review" },
  { key: "synthesis",  label: "Synthesis",  icon: Sparkles,      enterStatus: "review" },
];

const STATUS_BADGE: Record<LobbyStatus, { label: string; className: string }> = {
  roster:    { label: "Roster",    className: "bg-terminal-amber/15 text-terminal-amber border-terminal-amber/40" },
  planning:  { label: "Planning",  className: "bg-blue-500/15 text-blue-600 border-blue-500/30" },
  rolling:   { label: "Rolling",   className: "bg-terminal-green/15 text-terminal-green border-terminal-green/40" },
  review:    { label: "Review",    className: "bg-purple-500/15 text-purple-600 border-purple-500/30" },
  completed: { label: "Completed", className: "bg-terminal-muted/15 text-terminal-muted border-terminal-muted/40" },
  aborted:   { label: "Aborted",   className: "bg-red-500/15 text-red-600 border-red-500/30" },
};

/**
 * Compute which phases the lobby has entered (so the rail can dim future
 * phases and brighten reached ones). Synthesis is folded into "review" — the
 * lobby stays in `review` while the synthesizer runs (SPEC §5).
 */
function computeReachedPhases(
  status: LobbyStatus,
  hasSynthesisRun: boolean,
): Set<LobbyPhaseSection> {
  const reached = new Set<LobbyPhaseSection>();
  // Always reached.
  reached.add("roster");
  if (status === "roster") return reached;
  reached.add("planning");
  if (status === "planning") return reached;
  reached.add("rolling");
  if (status === "rolling") return reached;
  reached.add("review");
  if (status === "review" && hasSynthesisRun) reached.add("synthesis");
  if (status === "completed" || status === "aborted") {
    reached.add("synthesis");
  }
  return reached;
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function LobbyDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const lobbyId = params?.id ?? null;

  const { data, loading, error, refetch } = useLobbyDetail(lobbyId);

  // Wire the active lobby into the UI store so cross-component selectors
  // know which lobby is mounted. Reset everything else on lobby change.
  const resetForLobbyChange = useSoloStoryUiStore(
    (s) => s.resetForLobbyChange,
  );
  useEffect(() => {
    resetForLobbyChange(lobbyId);
    return () => resetForLobbyChange(null);
  }, [lobbyId, resetForLobbyChange]);

  useEffect(() => {
    if (data?.lobby) {
      document.title = `${data.lobby.title} — Selene`;
    } else {
      document.title = "Lobby — Selene";
    }
    return () => {
      document.title = "Selene";
    };
  }, [data?.lobby?.title]);

  return (
    <Shell>
      <ScrollArea className="h-full">
        <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-6">
          {/* ── Top bar ── */}
          <div>
            <Link
              href="/lobbies"
              className="inline-flex items-center gap-1.5 font-mono text-xs text-terminal-muted hover:text-terminal-dark"
            >
              <ArrowLeft className="h-3 w-3" />
              Back to lobbies
            </Link>
          </div>

          {loading ? (
            <DetailSkeleton />
          ) : error ? (
            <ErrorBanner error={error} onRetry={() => void refetch()} />
          ) : !data ? (
            <NotFoundBanner onBack={() => router.push("/lobbies")} />
          ) : (
            <>
              {/* ── Lobby header ── */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h1 className="font-mono text-2xl font-bold text-terminal-dark truncate">
                      {data.lobby.title}
                    </h1>
                    <StatusBadge status={data.lobby.status} />
                  </div>
                  <p className="mt-1 font-mono text-sm text-terminal-muted/90">
                    {data.lobby.goal}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void refetch()}
                    className="font-mono"
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Refresh
                  </Button>
                </div>
              </div>

              {/* ── Phase rail ── */}
              <PhaseRail
                status={data.lobby.status}
                hasSynthesisRun={data.lobby.synthesisRunId !== null}
              />

              {/* ── Sections (scroll-anchored) ── */}
              <RosterSectionPlaceholder
                seatCount={data.seats.length}
                lobbyStatus={data.lobby.status}
              />
              <PlanningSectionPlaceholder cardCount={data.cards.length} />
              <RollingSectionPlaceholder
                cardCount={data.cards.length}
                lobbyStatus={data.lobby.status}
              />
              <ReviewSectionPlaceholder
                approvedCount={
                  data.cards.filter((c) => c.status === "approved").length
                }
                pendingReviewCount={
                  data.cards.filter((c) => c.status === "awaiting_review").length
                }
              />
              <SynthesisSectionPlaceholder
                hasSynthesisRun={data.lobby.synthesisRunId !== null}
                hasArtifact={data.lobby.outputArtifactId !== null}
              />
            </>
          )}
        </div>
      </ScrollArea>
    </Shell>
  );
}

// ─── Phase rail ────────────────────────────────────────────────────────────

function PhaseRail({
  status,
  hasSynthesisRun,
}: {
  status: LobbyStatus;
  hasSynthesisRun: boolean;
}) {
  const reached = useMemo(
    () => computeReachedPhases(status, hasSynthesisRun),
    [status, hasSynthesisRun],
  );
  const { activeSection, setActiveSection } = useSectionControls();

  return (
    <nav
      aria-label="Lobby phase progress"
      className="flex items-stretch gap-1 rounded-lg border border-terminal-border/40 bg-terminal-cream/30 p-1"
    >
      {PHASES.map((phase) => {
        const isReached = reached.has(phase.key);
        const isActive = activeSection === phase.key;
        const Icon = phase.icon;
        return (
          <button
            key={phase.key}
            onClick={() => {
              setActiveSection(phase.key);
              // Smooth-scroll to the matching section.
              const el = document.getElementById(`section-${phase.key}`);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 font-mono text-xs transition-all",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green focus-visible:ring-offset-1",
              isActive
                ? "bg-terminal-cream text-terminal-dark shadow-sm"
                : isReached
                  ? "text-terminal-dark/80 hover:bg-terminal-cream/60"
                  : "text-terminal-muted/60 hover:text-terminal-muted",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="truncate">{phase.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ─── Section shell (used by every placeholder) ────────────────────────────

function PhaseSection({
  id,
  title,
  icon: Icon,
  children,
  rightSlot,
}: {
  id: LobbyPhaseSection;
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
}) {
  const isExpanded = useSoloStoryUiStore(
    (s) => s.expandedSections[id],
  );
  const toggleSection = useSoloStoryUiStore((s) => s.toggleSection);

  return (
    <Card
      id={`section-${id}`}
      className="bg-terminal-cream/30 border-terminal-border/50 scroll-mt-24"
    >
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-base flex items-center gap-2">
          <button
            onClick={() => toggleSection(id)}
            className="flex items-center gap-2 hover:text-terminal-green transition-colors"
            aria-expanded={isExpanded}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-terminal-muted" />
            ) : (
              <ChevronRight className="h-4 w-4 text-terminal-muted" />
            )}
            <Icon className="h-4 w-4 text-terminal-muted" />
            {title}
          </button>
          {rightSlot ? <div className="ml-auto">{rightSlot}</div> : null}
        </CardTitle>
      </CardHeader>
      {isExpanded ? <CardContent>{children}</CardContent> : null}
    </Card>
  );
}

// ─── Placeholder sections (Sprint 6-9 fill these in) ──────────────────────

function RosterSectionPlaceholder({
  seatCount,
  lobbyStatus,
}: {
  seatCount: number;
  lobbyStatus: LobbyStatus;
}) {
  return (
    <PhaseSection id="roster" title="Roster" icon={Users}>
      <div className="space-y-2">
        <p className="font-mono text-sm text-terminal-muted">
          {seatCount === 0
            ? "No seats yet. Sprint 6 will land the seat grid + agent picker + permission scope sheet."
            : `${seatCount} seat${seatCount === 1 ? "" : "s"} configured.`}
        </p>
        <p className="font-mono text-[11px] text-terminal-muted/60">
          Status: {lobbyStatus}
        </p>
      </div>
    </PhaseSection>
  );
}

function PlanningSectionPlaceholder({ cardCount }: { cardCount: number }) {
  return (
    <PhaseSection id="planning" title="Planning" icon={ClipboardList}>
      <p className="font-mono text-sm text-terminal-muted">
        {cardCount === 0
          ? "Planner output empty. Sprint 7 wires the planner deliberation transcript and editable card draft."
          : `${cardCount} card${cardCount === 1 ? "" : "s"} drafted by the planner.`}
      </p>
    </PhaseSection>
  );
}

function RollingSectionPlaceholder({
  cardCount,
  lobbyStatus,
}: {
  cardCount: number;
  lobbyStatus: LobbyStatus;
}) {
  return (
    <PhaseSection id="rolling" title="Rolling" icon={Activity}>
      <p className="font-mono text-sm text-terminal-muted">
        Sprint 7 lands the kanban (custom keyboard-first DnD, DAG overlay).
        Currently: {cardCount} card{cardCount === 1 ? "" : "s"} · lobby{" "}
        {lobbyStatus}.
      </p>
    </PhaseSection>
  );
}

function ReviewSectionPlaceholder({
  approvedCount,
  pendingReviewCount,
}: {
  approvedCount: number;
  pendingReviewCount: number;
}) {
  return (
    <PhaseSection id="review" title="Review" icon={CheckCircle2}>
      <p className="font-mono text-sm text-terminal-muted">
        Sprint 8 wires the live run embed + approve/reject/retry/edit
        controls. Currently: {approvedCount} approved · {pendingReviewCount}{" "}
        awaiting review.
      </p>
    </PhaseSection>
  );
}

function SynthesisSectionPlaceholder({
  hasSynthesisRun,
  hasArtifact,
}: {
  hasSynthesisRun: boolean;
  hasArtifact: boolean;
}) {
  return (
    <PhaseSection id="synthesis" title="Synthesis" icon={Sparkles}>
      <p className="font-mono text-sm text-terminal-muted">
        Sprint 9 lands the synthesizer kickoff + artifact viewer.{" "}
        {hasSynthesisRun
          ? hasArtifact
            ? "Artifact ready."
            : "Synthesis running."
          : "Not started."}
      </p>
    </PhaseSection>
  );
}

// ─── Misc ──────────────────────────────────────────────────────────────────

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

function ErrorBanner({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
      <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
      <div className="flex-1">
        <p className="font-mono text-sm text-red-600">Failed to load lobby</p>
        <p className="font-mono text-xs text-terminal-muted/80 mt-0.5">
          {error}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onRetry}
        className="font-mono"
      >
        Retry
      </Button>
    </div>
  );
}

function NotFoundBanner({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-terminal-border/40 bg-terminal-cream/30 px-6 py-10 text-center">
      <AlertCircle className="h-8 w-8 text-terminal-muted" />
      <div>
        <p className="font-mono text-sm font-medium text-terminal-dark">
          Lobby not found
        </p>
        <p className="mt-1 font-mono text-xs text-terminal-muted">
          It may have been deleted or you don't have access.
        </p>
      </div>
      <Button size="sm" onClick={onBack} className="font-mono">
        Back to lobbies
      </Button>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <Skeleton className="h-12 w-full" />
      {Array.from({ length: 3 }).map((_, i) => (
        <Card
          key={i}
          className="bg-terminal-cream/30 border-terminal-border/50"
        >
          <CardHeader>
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
      ))}
      <div className="flex items-center justify-center py-4">
        <Loader2 className="h-5 w-5 animate-spin text-terminal-muted" />
      </div>
    </div>
  );
}
