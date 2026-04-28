"use client";

/**
 * AgentPickerSheet — modal for choosing which character fills a seat.
 *
 * Renders the captain's character library (`useCharacters`, filtered to
 * `active` status) in a searchable list. Selection emits `onPick(agentId)`
 * back to RosterSection, which fires the `updateSeat` PATCH.
 *
 * SPEC §3 #6 forbids TanStack/SWR — `useCharacters` is plain useEffect.
 * Sheet semantics: built on shadcn Dialog primitive (the codebase has no
 * separate Sheet primitive). The "sheet" naming reflects the UX intent
 * (modal panel for a transient choice), not the underlying component.
 *
 * `seedSelectedAgentId` highlights the seat's current agent when reopening
 * the picker so the captain doesn't lose context. Null when the seat is
 * unfilled.
 */

import { useMemo, useState } from "react";
import { AlertCircle, Bot, Check, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import {
  useCharacters,
  type CharacterSummary,
} from "@/lib/lobbies/client/character-hooks";

export type AgentPickerSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Seat's role label, used in the header copy. */
  seatRole: string;
  /** Currently-assigned agent id (for highlighting). */
  seedSelectedAgentId: string | null;
  /** Called when the captain confirms a pick. */
  onPick: (agentId: string) => void;
};

export function AgentPickerSheet({
  open,
  onOpenChange,
  seatRole,
  seedSelectedAgentId,
  onPick,
}: AgentPickerSheetProps) {
  const { characters, loading, error } = useCharacters();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return characters;
    return characters.filter((c) => {
      const haystack = [
        c.name,
        c.displayName ?? "",
        c.tagline ?? "",
        c.metadata?.purpose ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [characters, query]);

  function handlePick(agent: CharacterSummary) {
    onPick(agent.id);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">
            Pick agent for{" "}
            <span className="text-terminal-green">{seatRole}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Choose which agent fills this seat. The agent's enabled tools
            become the default permission scope (you can tighten it next).
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-terminal-muted"
            aria-hidden="true"
          />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="pl-7 font-mono text-sm"
            aria-label="Search agents"
          />
        </div>

        <ScrollArea className="flex-1 -mx-6 px-6">
          {loading ? (
            <div className="flex items-center justify-center py-8 gap-2 text-terminal-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="font-mono text-xs">Loading agents…</span>
            </div>
          ) : error ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
            >
              <AlertCircle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
              <p className="font-mono text-xs text-destructive">{error}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
              <Bot className="h-6 w-6 text-terminal-muted" />
              <p className="font-mono text-xs text-terminal-muted">
                {characters.length === 0
                  ? "No active agents in your library yet."
                  : "No agents match your search."}
              </p>
            </div>
          ) : (
            <ul className="space-y-1 py-1">
              {filtered.map((agent) => {
                const isSelected = agent.id === seedSelectedAgentId;
                const toolCount =
                  agent.metadata?.enabledTools?.length ?? 0;
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      onClick={() => handlePick(agent)}
                      className={cn(
                        "w-full flex items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                        isSelected
                          ? "border-terminal-green bg-terminal-green/10"
                          : "border-terminal-border/60 hover:border-terminal-dark hover:bg-terminal-cream/60",
                      )}
                    >
                      <Bot className="h-4 w-4 text-terminal-dark mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-mono text-sm font-semibold text-terminal-dark truncate">
                            {agent.displayName ?? agent.name}
                          </p>
                          {agent.isDefault && (
                            <Badge
                              variant="outline"
                              className="font-mono text-[10px]"
                            >
                              Default
                            </Badge>
                          )}
                        </div>
                        {agent.tagline && (
                          <p className="font-mono text-[11px] text-terminal-muted truncate">
                            {agent.tagline}
                          </p>
                        )}
                        <p className="font-mono text-[10px] text-terminal-muted mt-0.5">
                          {toolCount} tool{toolCount === 1 ? "" : "s"}
                          {agent.metadata?.purpose
                            ? ` · ${String(agent.metadata.purpose).slice(0, 60)}`
                            : ""}
                        </p>
                      </div>
                      {isSelected && (
                        <Check
                          className="h-4 w-4 text-terminal-green shrink-0"
                          aria-label="Currently assigned"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
