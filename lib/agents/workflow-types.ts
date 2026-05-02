/**
 * Workflow types, interfaces, and metadata parsing helpers.
 * Extracted from workflows.ts to keep the main file focused on CRUD operations.
 */

import type {
  AgentWorkflowMemberRow,
  AgentWorkflowRow,
} from "@/lib/db/sqlite-workflows-schema";

// ── Public types ──────────────────────────────────────────────────────────────

export type WorkflowStatus = "active" | "paused" | "archived";

export interface WorkflowSharedResources {
  syncFolderIds: string[];
  pluginIds: string[];
  mcpServerNames: string[];
  hookEvents: string[];
}

export interface AgentWorkflow {
  id: string;
  userId: string;
  name: string;
  initiatorId: string;
  status: WorkflowStatus;
  metadata: {
    source: "plugin-import" | "manual" | "system-agents";
    pluginId?: string;
    pluginName?: string;
    pluginVersion?: string;
    idempotencyKey?: string;
    sharedResources: WorkflowSharedResources;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkflowMember {
  workflowId: string;
  agentId: string;
  role: "initiator" | "subagent";
  sourcePath?: string;
  metadataSeed?: {
    description?: string;
    purpose?: string;
    systemPromptSeed?: string;
    tags?: string[];
  };
}

export interface WorkflowMembershipContext {
  workflow: AgentWorkflow;
  member: AgentWorkflowMember;
}

export interface WorkflowResourceContext {
  workflowId: string;
  role: "initiator" | "subagent";
  sharedResources: WorkflowSharedResources;
  policy: {
    allowSharedFolders: boolean;
    allowSharedMcp: boolean;
    allowSharedHooks: boolean;
  };
  promptContext: string;
  promptContextInput: WorkflowPromptContextInput;
}

export interface WorkflowPromptContextDelegation {
  delegationId: string;
  delegateAgent: string;
  task: string;
  running: boolean;
  elapsed: number;
}

export interface WorkflowPromptContextInput {
  workflowName: string;
  role: "initiator" | "subagent";
  sharedPluginCount: number;
  sharedFolderCount: number;
  subagentDirectory: string[];
  activeDelegations?: WorkflowPromptContextDelegation[];
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

export function buildWorkflowPromptContext(input: WorkflowPromptContextInput): string {
  const lines: string[] = [
    `Workflow: ${input.workflowName}`,
    `Role: ${input.role}`,
    `Shared plugins: ${input.sharedPluginCount}`,
    `Shared folders: ${input.sharedFolderCount}`,
    "Sub-agents:",
    ...(input.subagentDirectory.length > 0 ? input.subagentDirectory : ["- none"]),
    "",
    "Standard terms: workflow, initiator, subagent, delegationId, agentId, observe, continue, stop.",
  ];

  if (input.role === "initiator") {
    lines.push(
      "",
      "## Initiator / Orchestrator Contract",
      "- Delegate by calling start with a task. The call may block or return in background mode depending on the execution context.",
      "- Launch multiple start calls in parallel for concurrent subagent work.",
      "- Do work directly when the task is simple, single-step, or faster to complete in current context.",
      "- Choose target subagent from directory by explicit purpose match before starting delegation.",
      "- Integrate and synthesize subagent results back to the user with clear decisions and next actions.",
      "- Multiple parallel delegations to the same subagent are supported — each gets its own session and delegationId.",
      "- IMPORTANT: When launching multiple delegations, emit ALL start calls in a single response. Never emit one start call per turn — that is sequential, not parallel.",
      "",
      "## Background Mode & Auto-Delivery",
      "- mode='background' returns immediately with a delegationId.",
      "- Results are auto-delivered: when a subagent completes, its full result is injected into your conversation automatically as a <delegation-result> message. You do NOT need to call observe() — just wait.",
      "- After launching background delegations, output a natural response (e.g. 'I've launched N agents, waiting for results...') and let the turn end. You will be notified when each agent completes.",
      "- If a <delegation-result> was injected, do not call observe() unless you need pending prompts, missing output, or a refresh; observe() returns compact already-delivered metadata by default after auto-delivery.",
      "- To intentionally re-read an already-delivered settled result, call observe with force=true.",
      "- resume: map to continue using delegationId to preserve delegation context.",
    );

    const activeDelegations = input.activeDelegations ?? [];
    if (activeDelegations.length > 0) {
      lines.push(
        "",
        "Active delegations:",
      );
      for (const del of activeDelegations) {
        const elapsed = Math.floor(del.elapsed / 1000);
        const status = del.running ? `running ${elapsed}s` : "settled";
        lines.push(`- ${del.delegationId}: "${del.delegateAgent}" - task: "${del.task}" (${status})`);
      }
    }
  } else {
    lines.push(
      "",
      "## Subagent / Executor Contract",
      "- Execute the initiator's delegated task precisely; keep scope tight unless clarification is required.",
      "- Return structured deliverables with sections: Summary, Findings, Evidence, Risks, Next Actions.",
      "- If data is missing or conflicting, explicitly escalate with what is missing and the minimum clarification needed.",
      "- Do not orchestrate further delegation unless the initiator explicitly requests it.",
      "- When blocked, provide a concise blocker report plus a concrete proposed path forward.",
    );
  }

  return lines.join("\n");
}

// ── Parsing helpers (used internally by workflows.ts) ─────────────────────────

export function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseSharedResources(raw: unknown): WorkflowSharedResources {
  const parsed = toObject(raw);
  return {
    syncFolderIds: toStringArray(parsed.syncFolderIds),
    pluginIds: toStringArray(parsed.pluginIds),
    mcpServerNames: toStringArray(parsed.mcpServerNames),
    hookEvents: toStringArray(parsed.hookEvents),
  };
}

function parseWorkflowMetadata(raw: unknown): AgentWorkflow["metadata"] {
  const parsed = toObject(raw);
  const source = parsed.source === "manual"
    ? "manual"
    : parsed.source === "system-agents"
      ? "system-agents"
      : "plugin-import";
  return {
    source,
    pluginId: typeof parsed.pluginId === "string" ? parsed.pluginId : undefined,
    pluginName: typeof parsed.pluginName === "string" ? parsed.pluginName : undefined,
    pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : undefined,
    idempotencyKey: typeof parsed.idempotencyKey === "string" ? parsed.idempotencyKey : undefined,
    sharedResources: parseSharedResources(parsed.sharedResources),
  };
}

function parseMemberMetadataSeed(raw: unknown): AgentWorkflowMember["metadataSeed"] {
  const parsed = toObject(raw);
  const tags = toStringArray(parsed.tags);
  return {
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    purpose: typeof parsed.purpose === "string" ? parsed.purpose : undefined,
    systemPromptSeed:
      typeof parsed.systemPromptSeed === "string" ? parsed.systemPromptSeed : undefined,
    tags: tags.length > 0 ? tags : undefined,
  };
}

export function mapWorkflowRow(row: AgentWorkflowRow): AgentWorkflow {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    initiatorId: row.initiatorId,
    status: row.status,
    metadata: parseWorkflowMetadata(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapWorkflowMemberRow(row: AgentWorkflowMemberRow): AgentWorkflowMember {
  return {
    workflowId: row.workflowId,
    agentId: row.agentId,
    role: row.role,
    sourcePath: row.sourcePath ?? undefined,
    metadataSeed: parseMemberMetadataSeed(row.metadataSeed),
  };
}
