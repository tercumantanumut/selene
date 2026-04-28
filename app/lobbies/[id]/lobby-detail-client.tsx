"use client";

/**
 * `/lobbies/[id]` — captain's lobby workspace shell (client component).
 *
 * Houses the full Solo Story flow as scroll-anchored sections (NOT a wizard
 * with hidden tabs — the FE Architect report's "progressive reveal"
 * guidance for Solo Story Mode; SPEC §3 itself doesn't list it as a hard
 * constraint, but it's the design intent the surface is built around).
 *
 * Sprint history (the inline comments are the source of truth for current
 * behaviour — this header just sketches scope landed per sprint):
 *   - Sprint 5    → SHELL: data fetch, phase progress rail, section
 *                   placeholders.
 *   - Sprint 5.1  → Pre-paint section seeding via layout effect to kill
 *                   the "wrong-section flash" on cold load.
 *   - Sprint 5.3  → Stale-data clear on lobbyId change (`useLobbyDetail`
 *                   nulls `data` when the URL flips), `useIsomorphicLayoutEffect`
 *                   SSR-safe shim, and `app/lobbies/error.tsx` segment-level
 *                   error boundary (sibling file).
 *   - Sprint 5.4  → Comment honesty pass — refreshed this header, corrected
 *                   the `seedDefaultsForStatus` rationale to match the
 *                   lobbyId-only gate it actually uses.
 *   - Sprint 6    → RosterSection wired in (was a seat-count placeholder).
 *   - Sprint 7A   → PlanningSection (planner banner, editable card drafts,
 *                   accept_plan transition).
 *   - Sprint 7B   → RollingSection wired in: keyboard-first kanban,
 *                   optimistic move overlay (`useSoloStoryUiStore`),
 *                   per-card cancel/retry, dependency editor + DAG overlay.
 *   - Sprint 8    → ReviewSection (live run embed + approve/reject/retry).
 *   - Sprint 9    → SynthesisSection wired in (StartSynthesisCard +
 *                   SynthesisRunProgress + ArtifactViewer); page-level
 *                   `useLobbyRunStream` now feeds both rolling and
 *                   synthesis via the `byRole` extension.
 *
 * Server-authoritative data lives on the server; this client calls
 * `useLobbyDetail` (fetch + useEffect) and feeds the cross-component UI
 * coordinator store (`useSoloStoryUiStore`) so other components on the page
 * can subscribe selectively (selected card, expanded transcripts, etc.).
 *
 * Auth: the parent server component (`page.tsx`) runs `requireAuth` before
 * rendering this — by mount time, the cookie session is guaranteed valid.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";

/**
 * Sprint 5.3: isomorphic `useLayoutEffect` shim. `useLayoutEffect` warns
 * during server rendering ("useLayoutEffect does nothing on the server")
 * because it has no useful semantics there. Even with `"use client"`,
 * Next.js renders the component once on the server for the initial HTML,
 * so the warning fires on every cold load. Falling back to `useEffect`
 * server-side silences the warning without changing client behaviour.
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
import {
  AlertCircle,
  ArrowLeft,
  BookOpenCheck,
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
import { useLobbyRunStream } from "@/lib/lobbies/client/run-stream";
import {
  useSoloStoryUiStore,
  useSectionControls,
  type LobbyPhaseSection,
} from "@/lib/stores/solo-story-ui-store";
import type { LobbyStatus } from "@/lib/lobbies/types";
import { LobbyStatusBadge } from "@/components/lobbies/status-badge";
import { RosterSection } from "@/components/lobbies/roster/roster-section";
import { PlanningSection } from "@/components/lobbies/planning/planning-section";
import { RollingSection } from "@/components/lobbies/rolling/rolling-section";
import { ReviewSection } from "@/components/lobbies/review/review-section";
import { SynthesisSection } from "@/components/lobbies/synthesis/synthesis-section";
import { SaveAsTemplateDialog } from "@/components/lobbies/save-as-template-dialog";
import { AbortLobbyButton } from "@/components/lobbies/abort-lobby-button";

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

export default function LobbyDetailClient() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const lobbyId = params?.id ?? null;

  const { data, loading, error, refetch } = useLobbyDetail(lobbyId);

  // Sprint 10: "Save as template" dialog state. Opens from the lobby
  // header; the dialog itself handles the POST + success toast and
  // dismisses on success. The state lives here (not on the dialog) so we
  // can disable the trigger while a save is in flight if we ever surface
  // that — V1 doesn't, but the seam is intentional.
  const [saveAsTemplateOpen, setSaveAsTemplateOpen] = useState(false);

  // Sprint 8: page-scoped SSE consumer for live card runs. Mounts at the
  // page level so a single EventSource feeds both the rolling kanban tiles
  // and the review section. The hook gates itself on a non-null lobbyId so
  // it stays inert during the loading skeleton.
  //
  // `onCardCompleted` fires once per `task:completed` for this lobby. We
  // refetch the lobby detail so card.status / output / lockVersion land
  // authoritatively (the SSE stream reports lifecycle, not the persisted
  // row). Refetching is idempotent and cheap (<200ms).
  const runStream = useLobbyRunStream(lobbyId, {
    onCardCompleted: () => {
      void refetch();
    },
    // Sprint 9: lobby-level (planner/synthesizer) run completions also
    // need a refetch so the persisted lobby fields land:
    //   - planner finish → cards rows materialize, lobby flips to `planning`.
    //   - synthesizer finish → `outputArtifactId` lands, status flips to
    //     `completed`. Without this refetch the SynthesisSection would
    //     remain stuck on the SynthesisRunProgress timeline even after
    //     the run reported succeeded.
    onRoleRunCompleted: () => {
      void refetch();
    },
  });

  // Wire the active lobby into the UI store so cross-component selectors
  // know which lobby is mounted. The destructive reset clears per-lobby UI
  // state — selected card, optimistic moves, etc. — and resets sections to
  // an all-collapsed baseline so the captain's first paint after
  // `loading=false` never flashes the wrong sections expanded.
  const resetForLobbyChange = useSoloStoryUiStore(
    (s) => s.resetForLobbyChange,
  );
  const seedDefaultsForStatus = useSoloStoryUiStore(
    (s) => s.seedDefaultsForStatus,
  );
  useEffect(() => {
    resetForLobbyChange(lobbyId);
    return () => resetForLobbyChange(null);
  }, [lobbyId, resetForLobbyChange]);

  // Once the lobby's status is known, seed the default expanded sections /
  // active section *idempotently*. `seedDefaultsForStatus` is a no-op after
  // the first call per `lobbyId` (the gate is lobbyId-only — see
  // `solo-story-ui-store.ts:seedDefaultsForStatus`), which protects three
  // things:
  //   1. Subsequent SSE-driven status flips within the same lobby do NOT
  //      re-seed — that's intentional, so a rolling→review promotion
  //      doesn't blow away the section toggles the captain set manually
  //      while watching the run.
  //   2. React 18 strict-mode double-invoke can't double-seed (the second
  //      invocation hits the lobbyId guard).
  //   3. A refetch that returns the same status is a no-op rather than a
  //      destructive reset of the captain's section toggles.
  // To force a re-seed for a fresh lobbyId, call `resetForLobbyChange`
  // first — that clears `seededForLobbyId` so the next seed call lands.
  // `useIsomorphicLayoutEffect` so the store update runs before paint on
  // the client — render 1 (with stale store value) is committed but not
  // yet painted; the layout effect updates the store; React schedules a
  // re-render before paint with the right expanded sections. Eliminates
  // the visible flicker for non-roster lobbies (HIGH finding, Sprint 5.1
  // review). On the server we fall back to `useEffect` to silence the
  // SSR warning — see shim definition above.
  const initialStatus = data?.lobby.status;
  useIsomorphicLayoutEffect(() => {
    if (lobbyId && initialStatus) {
      seedDefaultsForStatus(lobbyId, initialStatus);
    }
  }, [lobbyId, initialStatus, seedDefaultsForStatus]);

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
                    <LobbyStatusBadge status={data.lobby.status} />
                  </div>
                  <p className="mt-1 font-mono text-sm text-terminal-muted">
                    {data.lobby.goal}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {/*
                    "Save as template" — Sprint 10. Available at any phase
                    so a captain who designs a roster can save the
                    template even before rolling. We do NOT gate this on
                    `seats.length > 0`; the dialog itself surfaces the
                    "no seats yet" hint inline so the captain learns by
                    opening rather than by a disabled button without an
                    obvious reason.
                  */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSaveAsTemplateOpen(true)}
                    className="font-mono"
                    aria-label="Save this lobby's roster as a reusable template"
                  >
                    <BookOpenCheck className="mr-1.5 h-3.5 w-3.5" />
                    Save as template
                  </Button>
                  {/*
                    Sprint 9.1 (R5 BLOCKER B2 + B3): the abort lives in
                    the lobby header so it stays reachable across every
                    non-terminal phase — including `review` when the
                    synthesizer is in flight or wedged. Previously it
                    only existed inside RollingSection (gated on
                    `status === "rolling"`), which left captains with no
                    UI path to halt a stuck synthesis run. The button no-
                    ops on terminal statuses (completed/aborted) — the
                    component handles its own visibility.
                  */}
                  <AbortLobbyButton
                    lobby={data.lobby}
                    cards={data.cards}
                    onChanged={() => void refetch()}
                  />
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

              {/*
                Save-as-template dialog. Mounted inside the data-loaded
                branch so we know `data.lobby` and `data.seats` are
                populated. The dialog is keyed off lobby.id so reopening
                after a navigation re-seeds the name input correctly.
              */}
              <SaveAsTemplateDialog
                key={data.lobby.id}
                open={saveAsTemplateOpen}
                onOpenChange={setSaveAsTemplateOpen}
                lobby={data.lobby}
                seats={data.seats}
              />

              {/* ── Phase rail ── */}
              <PhaseRail
                status={data.lobby.status}
                hasSynthesisRun={data.lobby.synthesisRunId !== null}
              />

              {/* ── Sections (scroll-anchored) ── */}
              <PhaseSection id="roster" title="Roster" icon={Users}>
                <RosterSection
                  lobby={data.lobby}
                  seats={data.seats}
                  onChanged={() => void refetch()}
                />
              </PhaseSection>
              <PhaseSection
                id="planning"
                title="Planning"
                icon={ClipboardList}
              >
                <PlanningSection
                  lobby={data.lobby}
                  cards={data.cards}
                  seats={data.seats}
                  onChanged={() => void refetch()}
                />
              </PhaseSection>
              <PhaseSection id="rolling" title="Rolling" icon={Activity}>
                <RollingSection
                  lobby={data.lobby}
                  cards={data.cards}
                  dependencies={data.dependencies}
                  seats={data.seats}
                  runStream={runStream}
                  onChanged={() => void refetch()}
                />
              </PhaseSection>
              <PhaseSection id="review" title="Review" icon={CheckCircle2}>
                <ReviewSection
                  lobby={data.lobby}
                  cards={data.cards}
                  seats={data.seats}
                  runStream={runStream}
                  onChanged={() => void refetch()}
                />
              </PhaseSection>
              <PhaseSection id="synthesis" title="Synthesis" icon={Sparkles}>
                <SynthesisSection
                  lobby={data.lobby}
                  cards={data.cards}
                  runStream={runStream}
                  onChanged={() => void refetch()}
                />
              </PhaseSection>
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
  const { activeSection, setActiveSection, setSectionExpanded } =
    useSectionControls();

  return (
    <nav
      aria-label="Lobby phase progress"
      // Sticky so the rail stays visible while the captain scrolls through
      // long roster / kanban / synthesis sections. `top-0` anchors to the
      // ScrollArea viewport; `z-20` keeps it above PhaseSection cards which
      // also use `scroll-mt-24` to leave room for the rail when jumping
      // between sections.
      className="sticky top-0 z-20 -mx-2 flex items-stretch gap-1 rounded-lg border border-terminal-border/40 bg-terminal-cream/95 p-1 backdrop-blur supports-[backdrop-filter]:bg-terminal-cream/70"
    >
      {PHASES.map((phase) => {
        const isReached = reached.has(phase.key);
        const isActive = activeSection === phase.key;
        const Icon = phase.icon;
        return (
          <button
            key={phase.key}
            type="button"
            // `aria-current="step"` is the canonical landmark for "this is
            // the active step in a multi-step flow" (per WAI-ARIA §6.6.2).
            // Used by screen readers + heuristics like Safari Reader.
            aria-current={isActive ? "step" : undefined}
            aria-label={`${phase.label} phase${
              isReached ? "" : " (not yet reached)"
            }`}
            onClick={() => {
              setActiveSection(phase.key);
              // Auto-expand the target section so the smooth-scroll lands
              // on visible content rather than a collapsed header.
              setSectionExpanded(phase.key, true);
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
                  ? "text-terminal-dark hover:bg-terminal-cream/60"
                  : "text-terminal-muted hover:text-terminal-dark",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
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
  // Stable ids so `aria-controls` / `aria-labelledby` stay paired across
  // re-renders and the disclosure pattern is correctly announced.
  const headerId = `section-${id}-header`;
  const contentId = `section-${id}-content`;

  return (
    <Card
      id={`section-${id}`}
      role="region"
      aria-labelledby={headerId}
      className="bg-terminal-cream/30 border-terminal-border/50 scroll-mt-24"
    >
      <CardHeader className="pb-2">
        <CardTitle
          id={headerId}
          className="font-mono text-base flex items-center gap-2"
        >
          <button
            type="button"
            onClick={() => toggleSection(id)}
            className="flex items-center gap-2 hover:text-terminal-green transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green focus-visible:ring-offset-1 rounded"
            aria-expanded={isExpanded}
            aria-controls={contentId}
          >
            {isExpanded ? (
              <ChevronDown
                className="h-4 w-4 text-terminal-muted"
                aria-hidden="true"
              />
            ) : (
              <ChevronRight
                className="h-4 w-4 text-terminal-muted"
                aria-hidden="true"
              />
            )}
            <Icon
              className="h-4 w-4 text-terminal-muted"
              aria-hidden="true"
            />
            {title}
          </button>
          {rightSlot ? <div className="ml-auto">{rightSlot}</div> : null}
        </CardTitle>
      </CardHeader>
      {/*
        Always render CardContent so the matching `id` exists in the DOM for
        `aria-controls`. We hide-vs-collapse via `hidden` (a CSS-toggleable
        attribute) to keep semantics correct: SR reports the region exists
        but is collapsed, instead of "no such region" when it's just removed.
      */}
      <CardContent id={contentId} hidden={!isExpanded}>
        {isExpanded ? children : null}
      </CardContent>
    </Card>
  );
}

// ─── Misc ──────────────────────────────────────────────────────────────────

function ErrorBanner({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4"
    >
      <AlertCircle
        className="h-4 w-4 text-red-500 mt-0.5 shrink-0"
        aria-hidden="true"
      />
      <div className="flex-1">
        <p className="font-mono text-sm text-red-600">Failed to load lobby</p>
        <p className="font-mono text-xs text-terminal-muted mt-0.5">
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
