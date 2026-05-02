#!/usr/bin/env tsx
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSdkExecutableConfig } from "../lib/auth/claude-agent-sdk-auth";
import { getCliPath } from "../lib/auth/claude-login-process";

type AnyMessage = Record<string, unknown>;

const cwd = process.cwd();
const probeDir = join(tmpdir(), `selene-claude-subagent-probe-${Date.now()}`);
mkdirSync(probeDir, { recursive: true });

const { executable, env } = getSdkExecutableConfig();
const maxMessages = Number(process.env.CLAUDE_SUBAGENT_PROBE_MAX_MESSAGES || 240);
const timeoutMs = Number(process.env.CLAUDE_SUBAGENT_PROBE_TIMEOUT_MS || 120_000);

const prompt = `Use the Agent tool exactly once with subagent_type "general-purpose" and description "probe native stream". The subagent task: print three short progress lines labelled PROBE_STEP_1, PROBE_STEP_2, PROBE_STEP_3 and then return "PROBE_DONE". Do not use any filesystem or network tools. After the subagent returns, answer with PROBE_PARENT_DONE.`;

function summarizeMessage(message: AnyMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: message.type,
    subtype: message.subtype,
    parent_tool_use_id: message.parent_tool_use_id,
    task_id: message.task_id,
    tool_use_id: message.tool_use_id,
    tool_name: message.tool_name,
    session_id: message.session_id,
  };

  const event = message.event as AnyMessage | undefined;
  if (event && typeof event === "object") {
    out.event_type = event.type;
    out.event_index = event.index;
    const block = event.content_block as AnyMessage | undefined;
    if (block && typeof block === "object") {
      out.block_type = block.type;
      out.block_id = block.id;
      out.block_name = block.name;
    }
    const delta = event.delta as AnyMessage | undefined;
    if (delta && typeof delta === "object") {
      out.delta_type = delta.type;
      const text = typeof delta.text === "string" ? delta.text : undefined;
      const partial = typeof delta.partial_json === "string" ? delta.partial_json : undefined;
      out.delta_preview = (text ?? partial ?? "").slice(0, 160);
    }
  }

  if (typeof message.description === "string") out.description = message.description.slice(0, 160);
  if (typeof message.summary === "string") out.summary = message.summary.slice(0, 160);
  if (typeof message.result === "string") out.result = message.result.slice(0, 160);
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined && value !== null));
}

let sawRootAgentTool = false;
let sawNestedParentToolUseId = false;
let sawTaskLifecycle = false;
let sawToolProgressWithParent = false;
const messageTypeCounts = new Map<string, number>();
const parentToolUseIds = new Set<string>();
const taskIds = new Set<string>();
const startedAt = Date.now();

const abortController = new AbortController();
const timeout = setTimeout(() => abortController.abort(), timeoutMs);

async function main() {
try {
  console.log(JSON.stringify({ event: "probe:start", cwd, probeDir, maxMessages, timeoutMs }));
  const stream = query({
    prompt,
    options: {
      abortController,
      cwd: probeDir,
      additionalDirectories: [cwd],
      executable,
      pathToClaudeCodeExecutable: getCliPath(),
      includePartialMessages: true,
      includeHookEvents: true,
      settingSources: ["project"],
      model: process.env.CLAUDE_SUBAGENT_PROBE_MODEL || "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 20,
      persistSession: false,
      allowedTools: ["Agent"],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "WebFetch", "WebSearch"],
      agents: {
        "general-purpose": {
          description: "Probe subagent for Selene stream visibility validation",
          prompt: "You are a minimal probe subagent. Do not use tools. Return concise progress text only.",
          tools: [],
          model: "inherit",
        },
      },
    },
  });

  let count = 0;
  for await (const raw of stream as AsyncIterable<AnyMessage>) {
    count += 1;
    const key = [raw.type, raw.subtype].filter(Boolean).join(":") || "unknown";
    messageTypeCounts.set(key, (messageTypeCounts.get(key) ?? 0) + 1);

    if (typeof raw.parent_tool_use_id === "string" && raw.parent_tool_use_id) {
      sawNestedParentToolUseId = true;
      parentToolUseIds.add(raw.parent_tool_use_id);
    }
    if (raw.type === "tool_progress" && typeof raw.parent_tool_use_id === "string" && raw.parent_tool_use_id) {
      sawToolProgressWithParent = true;
    }
    if (raw.type === "system" && typeof raw.subtype === "string" && raw.subtype.startsWith("task_")) {
      sawTaskLifecycle = true;
      if (typeof raw.task_id === "string") taskIds.add(raw.task_id);
    }

    const event = raw.event as AnyMessage | undefined;
    const block = event?.content_block as AnyMessage | undefined;
    const blockName = typeof block?.name === "string" ? block.name : "";
    if (blockName === "Agent" || blockName === "Task") sawRootAgentTool = true;

    console.log(JSON.stringify({ event: "probe:message", index: count, ...summarizeMessage(raw) }));
    if (count >= maxMessages) {
      console.log(JSON.stringify({ event: "probe:max_messages_reached", count }));
      abortController.abort();
      break;
    }
  }

  const summary = {
    event: "probe:summary",
    ok: sawRootAgentTool && (sawNestedParentToolUseId || sawTaskLifecycle || sawToolProgressWithParent),
    sawRootAgentTool,
    sawNestedParentToolUseId,
    sawTaskLifecycle,
    sawToolProgressWithParent,
    parentToolUseIds: [...parentToolUseIds],
    taskIds: [...taskIds],
    messageTypeCounts: Object.fromEntries(messageTypeCounts),
    elapsedMs: Date.now() - startedAt,
  };
  console.log(JSON.stringify(summary));
  if (!summary.ok) process.exitCode = 2;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "probe:error", message, elapsedMs: Date.now() - startedAt }));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
}

void main();
