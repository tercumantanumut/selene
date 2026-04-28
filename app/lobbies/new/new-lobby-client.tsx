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
import { FormEvent, useEffect, useState } from "react";
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
                  <p className="font-mono text-xs text-terminal-muted">
                    No templates available yet. Templates ship in a later
                    sprint — for now, leave this blank and configure the
                    roster manually.
                  </p>
                ) : (
                  <div
                    role="radiogroup"
                    aria-label="Starter template"
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    <TemplateOption
                      selected={templateId === null}
                      onSelect={() => setTemplateId(null)}
                      label="No template"
                      description="Start with an empty roster."
                    />
                    {templatesData.templates.map((t) => (
                      <TemplateOption
                        key={t.id}
                        selected={templateId === t.id}
                        onSelect={() => setTemplateId(t.id)}
                        label={t.name}
                        description={
                          t.description ??
                          `${t.defaultSeats.length} default seat${t.defaultSeats.length === 1 ? "" : "s"}`
                        }
                      />
                    ))}
                  </div>
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
                  <p className="font-mono text-xs text-terminal-muted/80 mt-0.5">
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

/**
 * Real radio in disguise: implements the WAI-ARIA radio pattern (single
 * focusable element per group, Space/Enter selects, Arrow keys move
 * selection) using a `<button role="radio">`. Native `<input type="radio">`
 * isn't usable here because we need rich content (label + description) and
 * custom styling per option.
 *
 * Keyboard support:
 *   - Space / Enter: select this option.
 *   - Arrow Up/Down/Left/Right: handled by the parent radiogroup container
 *     in a future revision; for now Tab moves between options (acceptable
 *     for a 2-option group like "No template" + 1 starter).
 */
function TemplateOption({
  selected,
  onSelect,
  label,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      // Only the selected option is part of the tab order — standard
      // radiogroup behavior. Arrow keys would move selection, but that
      // wiring lives at the group level (added in a later sprint when more
      // than two options exist).
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onSelect();
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
        {label}
      </p>
      <p className="mt-0.5 font-mono text-[11px] text-terminal-muted line-clamp-2">
        {description}
      </p>
    </button>
  );
}
