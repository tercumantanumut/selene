"use client";

/**
 * DagOverlay — modal showing the lobby's dependency DAG as a topological
 * table.
 *
 * Why a table and not a force-directed / positioned graph view? SPEC §3 #6
 * forbids heavy UI deps (no react-flow, no d3-dag, no graphology). A pure
 * topological listing is:
 *   - cheap to render (O(V+E) text + Tailwind),
 *   - keyboard-navigable by default (real DOM rows, not SVG nodes),
 *   - readable at any zoom level.
 *
 * What the captain actually needs from this overlay:
 *   1. "What runs first?"  → topologically sorted root rows.
 *   2. "What's blocking X?" → the deps column for X.
 *   3. "What's downstream if X fails?" → the blocks column for X.
 *   4. "Is the plan a DAG at all?" → cycle detection (server-side, but
 *      we surface a banner if the local sort detects one — which would
 *      indicate stale client data).
 *
 * Topological sort uses Kahn's algorithm. If a cycle is detected (ever),
 * we list the unsorted residue at the bottom under "Cycle detected" so
 * the captain still sees their cards instead of a blank panel.
 */

import { useMemo } from "react";
import { AlertTriangle, GitFork, Network } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  LobbyCard,
  LobbyCardDependency,
} from "@/lib/db/sqlite-lobbies-schema";

// ─── Types ────────────────────────────────────────────────────────────────

export type DagOverlayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: LobbyCard[];
  dependencies: LobbyCardDependency[];
  /** Fires when the captain clicks "Edit dependencies" on a row. */
  onEditDependencies: (card: LobbyCard) => void;
};

type SortedRow = {
  card: LobbyCard;
  depth: number;
  upstream: LobbyCardDependency[];
  downstream: LobbyCard[];
};

// ─── Component ───────────────────────────────────────────────────────────

export function DagOverlay({
  open,
  onOpenChange,
  cards,
  dependencies,
  onEditDependencies,
}: DagOverlayProps) {
  const { sorted, unsorted } = useMemo(
    () => topoSortCards(cards, dependencies),
    [cards, dependencies],
  );

  const hasCycle = unsorted.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-base inline-flex items-center gap-2">
            <Network className="h-4 w-4" aria-hidden="true" />
            Dependency graph
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Cards listed in topological order. Indentation tracks dependency
            depth — root cards (no upstream) sit flush left, downstream
            cards step right per layer.
          </DialogDescription>
        </DialogHeader>

        {hasCycle && (
          <div
            role="alert"
            className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 inline-flex items-start gap-2"
          >
            <AlertTriangle
              className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <p className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
              Cycle detected in {unsorted.length} card
              {unsorted.length === 1 ? "" : "s"}. The orchestrator would
              reject this plan — fix the loop with the row's "Edit deps"
              button before accepting.
            </p>
          </div>
        )}

        <ScrollArea className="flex-1 -mx-6 px-6">
          {sorted.length === 0 && !hasCycle ? (
            <p className="font-mono text-xs text-terminal-muted py-6 text-center">
              No cards in this lobby yet.
            </p>
          ) : (
            <table className="w-full font-mono text-xs">
              <thead className="sticky top-0 bg-terminal-cream/95 backdrop-blur z-10">
                <tr className="text-left text-terminal-muted text-[10px] uppercase tracking-wider">
                  <th className="py-2 pr-3 font-semibold">Card</th>
                  <th className="py-2 pr-3 font-semibold">Depends on</th>
                  <th className="py-2 pr-3 font-semibold">Blocks</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 font-semibold sr-only">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <DagRow
                    key={row.card.id}
                    row={row}
                    onEdit={() => onEditDependencies(row.card)}
                  />
                ))}
                {unsorted.map((card) => (
                  <DagRow
                    key={card.id}
                    row={{
                      card,
                      depth: 0,
                      upstream: dependencies.filter(
                        (d) => d.cardId === card.id,
                      ),
                      downstream: cards.filter((c) =>
                        dependencies.some(
                          (d) =>
                            d.cardId === c.id && d.dependsOnCardId === card.id,
                        ),
                      ),
                    }}
                    isCycle
                    onEdit={() => onEditDependencies(card)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </ScrollArea>

        <p className="font-mono text-[10px] text-terminal-muted">
          Server validates the full DAG on every dependency edit — this
          panel is a captain's-eye view, not the source of truth.
        </p>
      </DialogContent>
    </Dialog>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function DagRow({
  row,
  isCycle,
  onEdit,
}: {
  row: SortedRow;
  isCycle?: boolean;
  onEdit: () => void;
}) {
  const { card, depth, upstream, downstream } = row;
  return (
    <tr
      className={cn(
        "border-t border-terminal-border/30",
        isCycle && "bg-amber-500/5",
      )}
    >
      <td className="py-2 pr-3 align-top">
        <div
          className="flex items-start gap-2"
          style={{ paddingLeft: `${depth * 12}px` }}
        >
          {depth > 0 && (
            <GitFork
              className="h-3 w-3 text-terminal-muted/60 mt-1 shrink-0"
              aria-hidden="true"
            />
          )}
          <span className="font-semibold text-terminal-dark truncate">
            {card.title}
          </span>
        </div>
      </td>
      <td className="py-2 pr-3 align-top text-terminal-muted text-[11px]">
        {upstream.length === 0 ? (
          <span className="italic">root</span>
        ) : (
          <span>
            {upstream.length} card{upstream.length === 1 ? "" : "s"}
            {upstream.some((d) => d.optional) ? " (some optional)" : ""}
          </span>
        )}
      </td>
      <td className="py-2 pr-3 align-top text-terminal-muted text-[11px]">
        {downstream.length === 0 ? (
          <span className="italic">none</span>
        ) : (
          <span>
            {downstream.length} card{downstream.length === 1 ? "" : "s"}
          </span>
        )}
      </td>
      <td className="py-2 pr-3 align-top">
        <Badge variant="outline" className="font-mono text-[10px]">
          {card.status}
        </Badge>
      </td>
      <td className="py-2 pr-3 align-top text-right">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onEdit}
          className="h-6 px-2 font-mono text-[10px]"
        >
          Edit deps
        </Button>
      </td>
    </tr>
  );
}

// ─── Topological sort (Kahn's algorithm) ─────────────────────────────────

/**
 * Returns cards in topological order plus any cards left in a cycle.
 * Depth tracks dependency layer (0 = root, n = max depth from a root).
 */
function topoSortCards(
  cards: LobbyCard[],
  dependencies: LobbyCardDependency[],
): { sorted: SortedRow[]; unsorted: LobbyCard[] } {
  const cardById = new Map(cards.map((c) => [c.id, c]));
  // Adjacency: dependsOnCardId → [cardId,...] (edge points from dep to dependent)
  const downstream = new Map<string, string[]>();
  // Indegree: cardId → number of upstream deps (counts only deps where the
  // upstream exists in this lobby — cross-lobby deps shouldn't happen, but
  // defensively skip them).
  const indegree = new Map<string, number>();
  // Per-card upstream list (for the row's "depends on" count).
  const upstreamByCard = new Map<string, LobbyCardDependency[]>();

  for (const c of cards) indegree.set(c.id, 0);

  for (const dep of dependencies) {
    if (!cardById.has(dep.cardId) || !cardById.has(dep.dependsOnCardId)) {
      continue;
    }
    const list = downstream.get(dep.dependsOnCardId) ?? [];
    list.push(dep.cardId);
    downstream.set(dep.dependsOnCardId, list);

    indegree.set(dep.cardId, (indegree.get(dep.cardId) ?? 0) + 1);

    const upList = upstreamByCard.get(dep.cardId) ?? [];
    upList.push(dep);
    upstreamByCard.set(dep.cardId, upList);
  }

  // Kahn: start with all roots (indegree 0), peel layer by layer.
  const queue: Array<{ id: string; depth: number }> = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push({ id, depth: 0 });
  }
  // Stable-sort roots by position so the table reads top-to-bottom in the
  // same order the captain sees in the Kanban backlog.
  queue.sort((a, b) => {
    const pa = cardById.get(a.id)?.position ?? 0;
    const pb = cardById.get(b.id)?.position ?? 0;
    return pa - pb;
  });

  const sorted: SortedRow[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const card = cardById.get(id);
    if (!card) continue;

    const upstream = upstreamByCard.get(id) ?? [];
    const downstreamCards = (downstream.get(id) ?? [])
      .map((cid) => cardById.get(cid))
      .filter((c): c is LobbyCard => !!c);

    sorted.push({ card, depth, upstream, downstream: downstreamCards });

    // Decrement indegrees of all downstream cards; enqueue when they hit 0.
    for (const childId of downstream.get(id) ?? []) {
      const next = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, next);
      if (next === 0) queue.push({ id: childId, depth: depth + 1 });
    }
  }

  // Anything not visited is in (or downstream of) a cycle.
  const unsorted = cards.filter((c) => !visited.has(c.id));

  return { sorted, unsorted };
}
