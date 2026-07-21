import type { ToolMetadata, ToolLoadingPreference, ResolvedToolLoadingPolicy } from "./types";
import type { MCPToolLoadingPreference } from "./mcp-tool-adapter";

export const REQUIRED_TOOL_IDS = new Set<string>([
  "searchTools",
  "retrieveFullContent",
]);

export const COMPANION_TOOL_IDS: Record<string, string[]> = {
  bash: ["executeCommand"],
};

type ResolveToolLoadingPolicyInput = {
  toolId: string;
  metadata: ToolMetadata;
  isAvailable?: boolean;
  agentEnabledTools?: Set<string>;
  toolLoadingPreferences?: Record<string, ToolLoadingPreference>;
  toolLoadingMode?: "deferred" | "always";
  includeTools?: Set<string>;
  legacyMcpPreference?: MCPToolLoadingPreference;
};

export function deriveDefaultToolLoadingPolicy(
  metadata: ToolMetadata
): "required" | "always" | "deferred" {
  if (metadata.loading.mandatory || metadata.loading.defaultPolicy === "required") {
    return "required";
  }
  if (metadata.loading.defaultPolicy) {
    return metadata.loading.defaultPolicy;
  }
  if (metadata.loading.alwaysLoad) {
    return "always";
  }
  if (metadata.loading.deferLoading) {
    return "deferred";
  }
  return "always";
}

export function isRequiredTool(toolId: string, metadata?: ToolMetadata): boolean {
  if (REQUIRED_TOOL_IDS.has(toolId)) return true;
  if (!metadata) return false;
  return metadata.loading.mandatory === true || metadata.loading.defaultPolicy === "required";
}

export function isPolicyDeferred(
  toolId: string,
  metadata: ToolMetadata,
  resolvedPolicies?: Map<string, ResolvedToolLoadingPolicy>
): boolean {
  const resolved = resolvedPolicies?.get(toolId);
  if (resolved) return resolved.policy === "deferred";
  return deriveDefaultToolLoadingPolicy(metadata) === "deferred";
}

export function getCompanionToolIds(toolId: string, metadata?: ToolMetadata): string[] {
  return [
    ...(COMPANION_TOOL_IDS[toolId] ?? []),
    ...(metadata?.loading.companions ?? []),
  ];
}

export function expandEnabledToolsWithCompanions(
  agentEnabledTools: Set<string> | undefined,
  getMetadata: (toolId: string) => ToolMetadata | undefined
): Set<string> | undefined {
  if (!agentEnabledTools) return undefined;

  const expanded = new Set(agentEnabledTools);
  let changed = true;

  while (changed) {
    changed = false;
    for (const toolId of Array.from(expanded)) {
      const metadata = getMetadata(toolId);
      for (const companionToolId of getCompanionToolIds(toolId, metadata)) {
        if (!expanded.has(companionToolId)) {
          expanded.add(companionToolId);
          changed = true;
        }
      }
    }
  }

  return expanded;
}

export function applyCompanionToolActivation(
  initialActiveTools: Set<string>,
  availableToolIds: Iterable<string>,
  getMetadata: (toolId: string) => ToolMetadata | undefined
): string[] {
  const available = new Set(availableToolIds);
  const promoted: string[] = [];
  let changed = true;

  while (changed) {
    changed = false;
    for (const toolId of Array.from(initialActiveTools)) {
      const metadata = getMetadata(toolId);
      for (const companionToolId of getCompanionToolIds(toolId, metadata)) {
        if (available.has(companionToolId) && !initialActiveTools.has(companionToolId)) {
          initialActiveTools.add(companionToolId);
          promoted.push(companionToolId);
          changed = true;
        }
      }
    }
  }

  return promoted;
}

export function resolveToolLoadingPolicy({
  toolId,
  metadata,
  isAvailable = true,
  agentEnabledTools,
  toolLoadingPreferences,
  toolLoadingMode = "deferred",
  includeTools,
  legacyMcpPreference,
}: ResolveToolLoadingPolicyInput): ResolvedToolLoadingPolicy {
  if (!isAvailable) {
    return {
      policy: "disabled",
      initiallyActive: false,
      discoverable: false,
      authorized: false,
      reason: "unavailable",
    };
  }

  const required = isRequiredTool(toolId, metadata);
  if (required) {
    return {
      policy: "required",
      initiallyActive: true,
      discoverable: true,
      authorized: true,
      reason: "required",
    };
  }

  const authorized = !agentEnabledTools || agentEnabledTools.has(toolId);
  if (!authorized) {
    return {
      policy: "disabled",
      initiallyActive: false,
      discoverable: false,
      authorized: false,
      reason: "not-enabled",
    };
  }

  if (includeTools?.has(toolId)) {
    return {
      policy: "always",
      initiallyActive: true,
      discoverable: true,
      authorized: true,
      reason: "runtime-include",
    };
  }

  const explicitPreference = toolLoadingPreferences?.[toolId];
  if (explicitPreference) {
    return {
      policy: explicitPreference,
      initiallyActive: explicitPreference === "always",
      discoverable: true,
      authorized: true,
      reason: "agent-override",
    };
  }

  if (legacyMcpPreference?.loadingMode) {
    const policy = legacyMcpPreference.loadingMode;
    return {
      policy,
      initiallyActive: policy === "always",
      discoverable: true,
      authorized: true,
      reason: "legacy-mcp-preference",
    };
  }

  if (toolLoadingMode === "always") {
    return {
      policy: "always",
      initiallyActive: true,
      discoverable: true,
      authorized: true,
      reason: "system-default",
    };
  }

  const defaultPolicy = deriveDefaultToolLoadingPolicy(metadata);
  const policy = defaultPolicy === "required" ? "always" : defaultPolicy;

  return {
    policy,
    initiallyActive: policy === "always",
    discoverable: true,
    authorized: true,
    reason: "tool-default",
  };
}
