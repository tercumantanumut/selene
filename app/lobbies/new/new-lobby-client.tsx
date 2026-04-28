"use client";

/**
 * `/lobbies/new` — captain creates a new lobby (client component).
 *
 * Minimal form for V1: title + goal + optional template. The captain fills in
 * seats and accepts the plan inside the lobby page after creation. SPEC §6
 * (POST /api/lobbies); template default seats are materialized server-side.
 *
 * Auth: the parent server component (`page.tsx`) runs `requireAuth` first.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  AlertCircle,
  Loader2,
  Plus,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { createLobby } from "@/lib/lobbies/client/api";
import { useLobbyTemplates } from "@/lib/lobbies/client/hooks";

// ─── Page ──────────────────────────────────────────────────────────────────

export default function NewLobbyClient() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    data: templatesData,
    loading: templatesLoading,
    error: templatesError,
  } = useLobbyTemplates();

  useEffect(() => {
    document.title = "New lobby — Selene";
    return () => {
      document.title = "Selene";
    };
  }, []);

  const canSubmit =
    title.trim().length > 0 && goal.trim().length > 0 && !submitting;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await createLobby({
        title: title.trim(),
        goal: goal.trim(),
        templateId: templateId ?? undefined,
      });
      router.push(`/lobbies/${result.lobby.id}`);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create lobby",
      );
      setSubmitting(false);
    }
  };

  return (
    <Shell>
      <ScrollArea className="h-full">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-6">
          {/* ── Header ── */}
          <div>
            <Link
              href="/lobbies"
              className="inline-flex items-center gap-1.5 font-mono text-xs text-terminal-muted hover:text-terminal-dark"
            >
              <ArrowLeft className="h-3 w-3" />
              Back to lobbies
            </Link>
            <h1 className="mt-2 font-mono text-2xl font-bold text-terminal-dark">
              New lobby
            </h1>
            <p className="font-mono text-sm text-terminal-muted mt-0.5">
              Define the goal. The crew, plan, and review steps follow inside
              the lobby.
            </p>
          </div>

          {/* ── Form ── */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <Card className="bg-terminal-cream/30 border-terminal-border/50">
              <CardHeader>
                <CardTitle className="font-mono text-base">Basics</CardTitle>
                <p className="font-mono text-xs text-terminal-muted">
                  Title and goal are required. Goal is what the synthesizer
                  uses to score acceptance criteria.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="title" className="font-mono text-sm">
                    Title
                  </Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Solo Story: Launch our pricing page"
                    autoComplete="off"
                    required
                    maxLength={200}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="goal" className="font-mono text-sm">
                    Goal
                  </Label>
                  <Textarea
                    id="goal"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="Ship a v1 pricing page with three tiers, a FAQ, and a CTA. Anchor copy on the discovery interviews from last week."
                    required
                    rows={5}
                    className="font-mono"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-terminal-cream/30 border-terminal-border/50">
              <CardHeader>
                <CardTitle className="font-mono text-base flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-terminal-muted" />
                  Starter template (optional)
                </CardTitle>
                <p className="font-mono text-xs text-terminal-muted">
                  Pick a template to seed the roster with default seats.
                  Otherwise you'll add seats manually inside the lobby.
                </p>
              </CardHeader>
              <CardContent>
                {templatesLoading ? (
                  <div
                    className="grid gap-2 sm:grid-cols-2"
                    aria-busy="true"
                    aria-label="Loading templates"
                  >
                    {Array.from({ length: 2 }).map((_, i) => (
                      <Skeleton key={i} className="h-14 w-full rounded-lg" />
                    ))}
                  </div>
                ) : templatesError ? (
                  <p
                    role="alert"
                    aria-live="polite"
                    className="font-mono text-xs text-red-500"
                  >
                    {templatesError}
                  </p>
                ) : !templatesData ||
                  templatesData.templates.length === 0 ? (
                  // Defensive empty-state. With Sprint 10's seed, this only
                  // renders if the boot-time `seedLobbyStarterTemplatesWith`
                  // failed (or was disabled) — the captain can still create
                  // a lobby with no template and configure the roster
                  // manually inside the lobby.
                  <p className="font-mono text-xs text-terminal-muted">
                    No starter templates were available. You can still create
                    the lobby and add seats manually inside it.
                  </p>
                ) : (
                  <TemplateRadioGroup
                    selectedId={templateId}
                    options={[
                      {
                        id: null,
                        label: "No template",
                        description:
                          "Start with an empty roster and the orchestrator default prompts.",
                      },
                      ...templatesData.templates.map((t) => ({
                        id: t.id,
                        label: t.name,
                        description:
                          t.description ??
                          `${t.defaultSeats.length} default seat${t.defaultSeats.length === 1 ? "" : "s"}`,
                      })),
                    ]}
                    onSelect={setTemplateId}
                  />
                )}
              </CardContent>
            </Card>

            {submitError ? (
              <div
                role="alert"
                aria-live="assertive"
                className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4"
              >
                <AlertCircle
                  className="h-4 w-4 text-red-500 mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                <div className="flex-1">
                  <p className="font-mono text-sm text-red-600">
                    Couldn&apos;t create lobby
                  </p>
                  <p className="font-mono text-xs text-terminal-muted mt-0.5">
                    {submitError}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="font-mono"
                onClick={() => router.push("/lobbies")}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="font-mono"
                disabled={!canSubmit}
              >
                {submitting ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-1.5 h-4 w-4" />
                )}
                Create lobby
              </Button>
            </div>
          </form>
        </div>
      </ScrollArea>
    </Shell>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

type TemplateRadioOption = {
  /** `null` represents the "No template" choice. */
  id: string | null;
  label: string;
  description: string;
};

/**
 * WAI-ARIA radiogroup with full keyboard support.
 *
 * Sprint 10 brings the count from "No template + maybe one starter" up to
 * "No template + 3 seeded starters" (and any user-saved private templates).
 * Past two options, the previous tab-only navigation is no longer
 * acceptable — screen readers and keyboard-only captains expect Arrow keys
 * to move selection inside a radiogroup.
 *
 * Pattern (https://www.w3.org/WAI/ARIA/apg/patterns/radio/):
 *   - Exactly one option is in the tab order at a time (`tabIndex={0}`); the
 *     others are `tabIndex={-1}`. The selected option is the tabbable one.
 *     If nothing is selected (an unusual state, but possible if the captain
 *     deliberately clears the selection), the FIRST option becomes tabbable
 *     so the group is still reachable from the form's Tab order.
 *   - Space / Enter selects the focused option.
 *   - Arrow Down / Right moves to the next option (wraps at the end).
 *   - Arrow Up / Left moves to the previous option (wraps at the start).
 *   - Home / End jump to first / last option.
 *
 * Wrapping is the spec's recommended behavior for radio groups (it diverges
 * from listbox / menu, where reaching the end is a hard stop).
 */
function TemplateRadioGroup({
  options,
  selectedId,
  onSelect,
}: {
  options: TemplateRadioOption[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Stable key → index map. We use it to compute the "currently focused
  // index" without relying on `document.activeElement`, which is brittle
  // under React's batching.
  const optionKey = useCallback(
    (opt: TemplateRadioOption) => opt.id ?? "__none__",
    [],
  );
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    options.forEach((opt, i) => map.set(optionKey(opt), i));
    return map;
  }, [options, optionKey]);

  const selectedIndex =
    indexById.get(selectedId ?? "__none__") ?? -1;

  /** Index that owns `tabIndex={0}`. Selected wins; otherwise first option. */
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const focusOption = useCallback((idx: number) => {
    const btn = buttonRefs.current[idx];
    btn?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (options.length === 0) return;

      // We need to know the focused option to decide where to move. The
      // group's currentTarget is the radiogroup; document.activeElement is
      // the button inside it. Map back to an index via the ref array.
      const active = document.activeElement;
      const currentIndex = buttonRefs.current.findIndex(
        (b) => b === active,
      );
      // Fallback to the selected/tabbable index if focus is somewhere else
      // (shouldn't happen normally, but keeps Arrow keys responsive).
      const startIndex = currentIndex >= 0 ? currentIndex : tabbableIndex;

      switch (e.key) {
        case "ArrowDown":
        case "ArrowRight": {
          e.preventDefault();
          const next = (startIndex + 1) % options.length;
          onSelect(options[next].id);
          focusOption(next);
          break;
        }
        case "ArrowUp":
        case "ArrowLeft": {
          e.preventDefault();
          const prev = (startIndex - 1 + options.length) % options.length;
          onSelect(options[prev].id);
          focusOption(prev);
          break;
        }
        case "Home": {
          e.preventDefault();
          onSelect(options[0].id);
          focusOption(0);
          break;
        }
        case "End": {
          e.preventDefault();
          const last = options.length - 1;
          onSelect(options[last].id);
          focusOption(last);
          break;
        }
      }
    },
    [options, onSelect, focusOption, tabbableIndex],
  );

  return (
    <div
      role="radiogroup"
      aria-label="Starter template"
      className="grid gap-2 sm:grid-cols-2"
      onKeyDown={onKeyDown}
    >
      {options.map((opt, i) => {
        const selected = (opt.id ?? "__none__") === (selectedId ?? "__none__");
        return (
          <button
            key={optionKey(opt)}
            ref={(el) => {
              buttonRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={i === tabbableIndex ? 0 : -1}
            onClick={() => onSelect(opt.id)}
            onKeyDown={(e) => {
              // Space / Enter activate the focused option per the radio
              // pattern. We stop propagation so the parent radiogroup's
              // arrow-key handler doesn't also fire on the same event.
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onSelect(opt.id);
              }
            }}
            className={cn(
              "rounded-lg border px-3 py-2 text-left transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green focus-visible:ring-offset-1",
              selected
                ? "border-terminal-green/60 bg-terminal-green/10"
                : "border-terminal-border/40 bg-terminal-cream/40 hover:bg-terminal-cream/70",
            )}
          >
            <p className="font-mono text-sm font-medium text-terminal-dark truncate">
              {opt.label}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-terminal-muted line-clamp-2">
              {opt.description}
            </p>
          </button>
        );
      })}
    </div>
  );
}
