// ==========================================================================
// character-picker-types.ts
// Shared types for the character picker and its sub-components.
// ==========================================================================

export interface AgentModelConfigDraft {
  provider: string;
  chatModel: string;
  researchModel: string;
  visionModel: string;
  utilityModel: string;
  transcriberModel: string;
}

export interface IdentityEditorFormState {
  name: string;
  displayName: string;
  tagline: string;
  purpose: string;
  systemPromptOverride: string;
  modelConfig: AgentModelConfigDraft;
}

export interface CharacterSummary {
  id: string;
  name: string;
  displayName?: string | null;
  tagline?: string | null;
  status: string;
  isDefault?: boolean;
  metadata?: {
    enabledTools?: string[];
    toolLoadingPreferences?: Record<string, "always" | "deferred">;
    enabledMcpTools?: string[];
    enabledPlugins?: string[];
    purpose?: string;
    isSystemAgent?: boolean;
    modelConfig?: {
      provider?: string;
      chatModel?: string;
      researchModel?: string;
      visionModel?: string;
      utilityModel?: string;
    };
    avatarConfig?: {
      source: string;
      presetId?: string;
      modelUrl: string;
      bodyType: string;
    };
  };
  images?: Array<{
    url: string;
    isPrimary: boolean;
    imageType: string;
  }>;
  // Active session tracking
  hasActiveSession?: boolean;
  activeSessionId?: string | null;
  stats?: {
    skillCount: number;
    runCount: number;
    successRate: number | null;
    lastActive: string | null;
  };
}

export interface WorkflowMember {
  agentId: string;
  role: "initiator" | "subagent";
}

export interface WorkflowGroup {
  id: string;
  name: string;
  status: string;
  initiatorId: string;
  metadata: {
    source?: "system-agents" | "manual" | "plugin-import";
    sharedResources?: {
      syncFolderIds?: string[];
      pluginIds?: string[];
      mcpServerNames?: string[];
      hookEvents?: string[];
    };
  };
  members: WorkflowMember[];
  agents: CharacterSummary[];
}
