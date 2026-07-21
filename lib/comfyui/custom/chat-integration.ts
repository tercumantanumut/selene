import type { Tool } from "ai";
import { ToolRegistry } from "@/lib/ai/tool-registry/registry";
import type { ToolMetadata } from "@/lib/ai/tool-registry/types";
import { buildCustomComfyUITool } from "./tool";
import { listCustomComfyUIWorkflows } from "./store";
import type { CustomComfyUIWorkflow } from "./types";

interface CustomComfyUIToolLoadResult {
  allTools: Record<string, Tool>;
  alwaysLoadToolIds: string[];
  deferredToolIds: string[];
}

export function getCustomComfyUIToolId(workflowId: string): string {
  return `customComfyUI_${workflowId}`;
}

function workflowToMetadata(workflow: CustomComfyUIWorkflow): ToolMetadata {
  const keywords = [
    "comfyui",
    "workflow",
    workflow.name.toLowerCase(),
    ...workflow.inputs.map((input) => input.name.toLowerCase()),
  ];

  return {
    displayName: workflow.name,
    category: "custom-comfyui",
    keywords,
    shortDescription:
      workflow.description || `Custom ComfyUI workflow: ${workflow.name}`,
    fullInstructions: `## ${workflow.name}\n\n${workflow.description || "Custom ComfyUI workflow."}`,
    loading: {
      deferLoading: workflow.loadingMode !== "always",
      alwaysLoad: workflow.loadingMode === "always",
      defaultPolicy: workflow.loadingMode === "always" ? "always" : "deferred",
    },
    requiresSession: false,
  };
}

export async function loadCustomComfyUITools(
  sessionId?: string
): Promise<CustomComfyUIToolLoadResult> {
  const registry = ToolRegistry.getInstance();
  const workflows = await listCustomComfyUIWorkflows();

  const allTools: Record<string, Tool> = {};
  const alwaysLoadToolIds: string[] = [];
  const deferredToolIds: string[] = [];

  workflows.forEach((workflow) => {
    if (workflow.enabled === false) return;
    const toolId = getCustomComfyUIToolId(workflow.id);
    const metadata = workflowToMetadata(workflow);
    registry.register(toolId, metadata, (options) => buildCustomComfyUITool(workflow, options.sessionId));

    allTools[toolId] = buildCustomComfyUITool(workflow, sessionId);

    if (metadata.loading.alwaysLoad) {
      alwaysLoadToolIds.push(toolId);
    } else {
      deferredToolIds.push(toolId);
    }
  });

  return { allTools, alwaysLoadToolIds, deferredToolIds };
}
