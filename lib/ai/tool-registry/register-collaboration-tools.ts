import type { ToolMetadata } from "./types";
import { ToolRegistry } from "./registry";
import { createBashTool } from "../tools/bash-tool";
import { createExecuteCommandTool } from "../tools/execute-command-tool";
import { createEditFileTool } from "../tools/edit-file-tool";
import { createWriteFileTool } from "../tools/write-file-tool";
import { createPatchFileTool } from "../tools/patch-file-tool";
import { createScheduleTaskTool } from "../tools/schedule-task-tool";
import { createSkillTool } from "../tools/skill-tool";
import { createMemorizeTool } from "../tools/memorize-tool";
import { createCalculatorTool } from "../tools/calculator-tool";
import { createUpdatePlanTool } from "../tools/update-plan-tool";
import { createWorkspaceTool } from "../tools/workspace-tool";
import { createChromiumWorkspaceTool } from "../tools/chromium-workspace-tool";
import { createDesignWorkspaceTool } from "../tools/design-workspace-tool";
import { createApplyPatchTool } from "../tools/apply-patch-tool";

import { createAskUserQuestionTool } from "../tools/ask-user-question-tool";
import { createPromptLibraryTool } from "../tools/prompt-library-tool";
import { getPromptLibraryRulesSummary, getSceneGuideSummary } from "@/data/prompt-library/optimization-rules";

export function registerCollaborationTools(registry: ToolRegistry): void {
  registry.register(
    "bash",
    {
      displayName: "Bash",
      category: "utility",
      keywords: [
        "bash",
        "shell",
        "terminal",
        "command",
        "script",
        "git",
        "npm",
        "pnpm",
        "python",
        "run",
        "background",
      ],
      searchHint: "run shell commands in bash",
      shortDescription:
        "Run shell commands with a single command string and persistent working directory",
      fullInstructions: `## Bash

Run shell commands with a single shell string.

**Key behavior:**
- Working directory persists across calls for the current session
- Use one command string instead of splitting command + args
- Supports background execution with \`run_in_background\`
- Use \`processId\` with \`action: "status"\` or \`action: "kill"\` to manage background commands

**Examples:**
- \`{ command: "git status" }\`
- \`{ command: "cd app && npm test" }\`
- \`{ command: "npm run dev", run_in_background: true }\`

**Execution scope:**
- Commands default to synced folders/worktrees
- \`SELENE_UNSAFE_AGENT_PERMISSIONS=true\` allows broader local filesystem access
- Prefer dedicated file/search tools when they are a better fit`,
      loading: { deferLoading: true, defaultPolicy: "deferred", companions: ["executeCommand"] },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, userId, characterId, onExecuteCommandProgress }) =>
      createBashTool({
        sessionId: sessionId || "UNSCOPED",
        userId,
        characterId: characterId ?? null,
        onProgress: onExecuteCommandProgress,
      })
  );

  // Execute Command Tool - Run shell commands safely within synced directories
  registry.register(
    "executeCommand",
    {
      displayName: "Execute Command",
      category: "utility",
      keywords: [
        "execute",
        "command",
        "shell",
        "terminal",
        "npm",
        "yarn",
        "pnpm",
        "git",
        "run",
        "script",
        "build",
        "test",
        "lint",
        "install",
        "cli",
      ],
      searchHint: "execute shell commands with explicit command and args",
      shortDescription:
        "Execute shell commands within the agent execution scope",
      fullInstructions: `## Execute Command

Run shell commands in synced folders by default. \`SELENE_UNSAFE_AGENT_PERMISSIONS=true\` allows broader local filesystem access.

**Key rules:**
- \`command\` = executable only (e.g., "npm"), NOT a full shell line
- \`args\` = array of arguments (e.g., ["run", "build"])
- Prefer \`localGrep\` for codebase file discovery/search (primary path)
- If \`localGrep\` is unavailable/fails, using \`executeCommand\` with \`rg\` is a supported fallback
- For shell fallback, pass \`command: "rg"\` and \`args: ["..."]\` (do not pass one full shell string)
- If using shell listings, always self-limit output (e.g., \`head\`, \`Select-Object -First\`)
- Python inline: \`{ command: "python", args: ["-c", "print('hello')"] }\`
- 30s default timeout (max 5min)`,
      loading: { alwaysLoad: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, userId, characterId, onExecuteCommandProgress }) =>
      createExecuteCommandTool({
        sessionId: sessionId || "UNSCOPED",
        userId,
        characterId: characterId ?? null,
        onProgress: onExecuteCommandProgress,
      })
  );

  // Edit File Tool - Targeted string replacement in files
  registry.register(
    "editFile",
    {
      displayName: "Edit File",
      category: "knowledge",
      keywords: [
        "edit",
        "file",
        "modify",
        "change",
        "replace",
        "code",
        "update",
        "refactor",
        "fix",
        "patch",
        "string",
        "write",
      ],
      shortDescription:
        "Edit a file by replacing a specific string with new content",
      fullInstructions: `## Edit File

Replace a unique string in a file within synced folders. Also creates new files.

**Modes:**
- Edit: \`{ filePath, oldString: "unique text", newString: "replacement" }\`
- Create: \`{ filePath, oldString: "", newString: "file content" }\`
- Delete text: \`{ filePath, oldString: "text to remove", newString: "" }\`

**Rules:**
- oldString must appear EXACTLY once in the file (add context if not unique)
- File must be read with readFile before editing
- Stale detection: re-read if file was modified externally
- Diagnostics (tsc/eslint) run automatically after edit`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, characterId }) =>
      createEditFileTool({
        sessionId: sessionId || "UNSCOPED",
        characterId: characterId ?? null,
      })
  );

  // Write File Tool - Full file write/create
  registry.register(
    "writeFile",
    {
      displayName: "Write File",
      category: "knowledge",
      keywords: [
        "write",
        "file",
        "create",
        "overwrite",
        "save",
        "new",
        "content",
        "output",
      ],
      shortDescription:
        "Write full content to a file (create new or overwrite existing)",
      fullInstructions: `## Write File

Write full content to a file within synced folders. Creates or overwrites.

**Usage:** \`{ filePath: "src/utils.ts", content: "// Full file content here" }\`

**Rules:**
- For existing files: prefer editFile for small changes (preserves unmodified content)
- Stale detection: warns if file modified since last read
- Max 1MB content size
- Diagnostics run automatically after write`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, characterId }) =>
      createWriteFileTool({
        sessionId: sessionId || "UNSCOPED",
        characterId: characterId ?? null,
      })
  );

  // Patch File Tool - Multi-file batch operations
  registry.register(
    "patchFile",
    {
      displayName: "Patch Files",
      category: "knowledge",
      keywords: [
        "patch",
        "multi",
        "batch",
        "bulk",
        "refactor",
        "multiple",
        "files",
        "atomic",
        "update",
        "create",
        "delete",
      ],
      shortDescription:
        "Apply multiple file operations atomically (update/create/delete)",
      fullInstructions: `## Patch Files

Apply batch operations across multiple files atomically. All operations validated before any writes.

**Operations:**
- update: \`{ action: "update", filePath, oldString, newString }\`
- create: \`{ action: "create", filePath, newString: "content" }\`
- delete: \`{ action: "delete", filePath }\`

**Example:** \`{ operations: [{ action: "update", filePath: "a.ts", oldString: "old", newString: "new" }, { action: "create", filePath: "b.ts", newString: "content" }] }\`

**Safety:** If any operation fails validation, NO files are modified.`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, characterId }) =>
      createPatchFileTool({
        sessionId: sessionId || "UNSCOPED",
        characterId: characterId ?? null,
      })
  );

  // Apply Patch Tool - First-class patch application (no shell/heredoc needed)
  registry.register(
    "applyPatch",
    {
      displayName: "Apply Patch",
      category: "knowledge",
      keywords: [
        "patch",
        "apply",
        "apply_patch",
        "diff",
        "edit",
        "modify",
        "update",
        "file",
        "heredoc",
      ],
      shortDescription:
        "Apply a unified patch to modify, create, or delete files directly — no shell wrapping needed",
      fullInstructions: `## Apply Patch

Apply file patches directly without shell wrapping. Accepts the patch text as a parameter — works identically on Windows, macOS, and Linux.

**Format:**
\`\`\`
*** Begin Patch
*** Update File: path/to/file.ts
@@
 context line
-old line
+new line
*** Add File: path/to/new.ts
+content
*** Delete File: path/to/old.ts
*** End Patch
\`\`\`

**Preferred over bash heredoc** — avoids platform-specific shell syntax issues.`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, characterId }) =>
      createApplyPatchTool({
        sessionId: sessionId || "UNSCOPED",
        characterId: characterId ?? null,
      })
  );

  // Schedule Task Tool - Schedule tasks for future execution
  registry.register(
    "scheduleTask",
    {
      displayName: "Schedule Task",
      category: "scheduling",
      keywords: [
        "schedule",
        "task",
        "cron",
        "timer",
        "reminder",
        "future",
        "recurring",
        "automation",
        "daily",
        "weekly",
        "hourly",
        "interval",
        "scheduled",
        "job",
        "automate",
      ],
      shortDescription:
        "Schedule tasks for future execution (one-time, recurring, or interval-based)",
      fullInstructions: `## Schedule Task

Schedule future tasks (cron/interval/once). Task runs with agent's full context and tools.

**Types:** cron (\`cronExpression\`), interval (\`intervalMinutes\`), once (\`scheduledAt\` ISO timestamp).

**Cron patterns:** \`0 9 * * 1-5\` (9am weekdays), \`0 0 * * *\` (midnight daily), \`*/30 * * * *\` (every 30min), \`0 0 1 * *\` (monthly).

**Template variables in prompts:** \`{{NOW}}\`, \`{{TODAY}}\`, \`{{YESTERDAY}}\`, \`{{WEEKDAY}}\`, \`{{MONTH}}\`, \`{{LAST_7_DAYS}}\`, \`{{LAST_30_DAYS}}\` — resolved at execution time.

**Timezone:** Always use IANA format (e.g., "Europe/Berlin"). The tool auto-converts common formats: GMT+1, CET, EST, city names ("Berlin", "Tokyo"). If ambiguous, ask the user to confirm their city.

**Delivery channel:** Use \`deliveryChannel: "auto"\` (default) to deliver results to the same channel the user is chatting from (e.g., Telegram → Telegram). Override with "app", "telegram", "slack", "whatsapp".

**Calendar mirroring:** Set \`mirrorToCalendar: true\` to also create a Google Calendar event via configured MCP. Requires a calendar MCP server (e.g., Composio). Use \`calendarDurationMinutes\` for event length (default: 15).`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, userId, characterId }) =>
      createScheduleTaskTool({
        sessionId: sessionId || "UNSCOPED",
        userId: userId || "UNSCOPED",
        characterId: characterId || "UNSCOPED",
      })
  );

  // Skills: unified list/inspect/run + create/patch/replace/metadata/copy/archive
  registry.register(
    "skill",
    {
      displayName: "Skill",
      category: "utility",
      keywords: [
        "skill", "run skill", "inspect skill", "list skills", "execute skill",
        "create skill", "update skill", "patch skill", "replace skill",
        "copy skill", "archive skill", "skill by id", "skill by name",
      ],
      shortDescription: "Unified skill tool: list, inspect, run, create, patch, replace, metadata, copy, archive",
      loading: { alwaysLoad: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, userId, characterId }) =>
      createSkillTool({
        sessionId: sessionId || "UNSCOPED",
        userId: userId || "UNSCOPED",
        characterId: characterId || "UNSCOPED",
      })
  );

  // Memorize Tool - Save memories on demand
  registry.register(
    "memorize",
    {
      displayName: "Memorize",
      category: "utility",
      keywords: [
        "memorize", "remember", "memory", "save", "note",
        "preference", "fact", "learn", "store",
        "always", "never", "my name", "I prefer",
        "note for future", "keep in mind",
      ],
      shortDescription:
        "Save a fact, preference, or instruction to remember across conversations",
      fullInstructions: `## Memorize

Save memories when the user says "remember that...", "memorize this", "note for future reference", "my name is...", "I prefer...", "always do X", etc.

**Guidelines:**
- One fact per memory — keep it concise and specific
- Don't duplicate existing memories (tool checks automatically)
- Pick the best category or omit to default to domain_knowledge
- Categories: visual_preferences, communication_style, workflow_patterns, domain_knowledge, business_rules
- Memories are immediately active in all future conversations`,
      loading: { alwaysLoad: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, characterId }) =>
      createMemorizeTool({
        sessionId: sessionId || "UNSCOPED",
        characterId: characterId || "UNSCOPED",
      })
  );

  // Calculator Tool - Safe mathematical calculations
  registry.register(
    "calculator",
    {
      displayName: "Calculator",
      category: "utility",
      keywords: [
        "calculate",
        "calculator",
        "math",
        "arithmetic",
        "compute",
        "add",
        "subtract",
        "multiply",
        "divide",
        "sum",
        "percentage",
        "percent",
        "tax",
        "interest",
        "compound",
        "statistics",
        "mean",
        "median",
        "sqrt",
        "power",
        "exponent",
        "trigonometry",
        "sin",
        "cos",
        "convert",
        "unit",
        "formula",
      ],
      shortDescription:
        "Perform accurate mathematical calculations - arithmetic, statistics, trigonometry, unit conversions",
      fullInstructions: `## Calculator

Use instead of doing math yourself — returns deterministic, accurate results.

**Supports:** arithmetic, trig (radians), log, constants (pi/e/phi), statistics (mean/median/std), units ("5 miles to km"), matrix, complex numbers.

**Example:** \`calculator({ expression: "10000 * (1 + 0.07)^30", precision: 2 })\``,
      loading: { deferLoading: true },
      requiresSession: false,
    } satisfies ToolMetadata,
    () => createCalculatorTool()
  );

  // Update Plan Tool - Create or update a visible task plan
  registry.register(
    "updatePlan",
    {
      displayName: "Update Plan",
      category: "utility",
      keywords: [
        "plan", "update plan", "task plan", "steps", "todo", "progress",
        "checklist", "roadmap", "track", "status", "milestone",
      ],
      shortDescription:
        "Create or update a visible task plan with step statuses across the conversation",
      fullInstructions: `## Update Plan

Creates or updates a visible task plan. First call creates; subsequent calls update.

**Quick decision:**
- No plan yet → call with steps and text for each (mode="replace" is default)
- Update step status → pass only its id + new status, mode="merge" (text is optional — existing text preserved)
- Change step text → pass id + new text + status, mode="merge"
- Redo entirely → new steps with text, mode="replace"

**IMPORTANT for merge updates:** Only send the steps that changed. Do NOT resend all steps.
Example: \`{ "steps": [{"id": "step_abc", "status": "completed"}], "mode": "merge" }\`

**Constraints:** Max 20 steps. Only 1 step can be "in_progress" at a time. Use returned step ids for merge updates.`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId }) => createUpdatePlanTool({ sessionId: sessionId || "UNSCOPED" })
  );

  // Workspace Tool - Create and manage git worktree workspaces
  registry.register(
    "workspace",
    {
      displayName: "Workspace",
      category: "utility",
      keywords: [
        "workspace", "worktree", "git", "branch", "isolate", "feature",
        "code changes", "separate branch", "pr", "pull request",
      ],
      shortDescription:
        "Create and manage git worktree workspaces for isolated code changes",
      fullInstructions: `## Workspace (Git Worktree Manager)

Create isolated git worktrees so the user's main branch stays clean.
File tools (readFile, editFile, writeFile, localGrep) automatically work in the worktree.

**Actions:**
- \`create\`: Create a new worktree + branch. Requires \`branch\` and \`repoPath\`.
  Example: \`{ action: "create", branch: "feature/auth-refactor", repoPath: "/path/to/repo" }\`
- \`status\`: Check live git status of the current workspace (changed files, branch info).
- \`update-metadata\`: Update PR info or lifecycle status after creating a PR or finishing work.
- \`delete\`: Remove the workspace — deletes git worktree and cleans up resources.

**Workflow:**
1. User asks to work on a feature → call workspace with action "create"
2. Use file tools (readFile, editFile, writeFile) and executeCommand in the worktree path
3. When changes are ready, **ask the user** what they want to do next and **memorize their preference** (if the memorize tool is available) so you don't have to ask again:
   - Keep changes local (just commit)
   - Push to remote (\`git push -u origin <branch>\`)
   - Push and create a PR (\`gh pr create ...\`)
4. If creating a PR: push first, then use \`gh pr create\`, then update-metadata with the real URL
5. Clean up with action "delete" when work is complete

**NEVER:**
- Fabricate or guess PR URLs — only use URLs from \`gh pr create\` / \`gh pr view\` output
- Push or create PRs without asking the user first
- Skip verifying that a git command succeeded before proceeding to the next step`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, userId, characterId }) =>
      createWorkspaceTool({
        sessionId: sessionId || "UNSCOPED",
        characterId: characterId || "UNSCOPED",
        userId: userId || "UNSCOPED",
      })
  );

  // Ask User Question Tool - Interactive user clarification with selectable options


  // Prompt Library Tool - curated image generation prompt references
  registry.register(
    "promptLibrary",
    {
      displayName: "Prompt Library",
      category: "knowledge",
      keywords: [
        "prompt",
        "image",
        "generation",
        "nanobanana",
        "trending",
        "photography",
        "portrait",
        "cinematic",
        "template",
        "inspiration",
        "style",
        "composition",
        "creative",
        "reference",
        "example",
      ],
      shortDescription:
        "Search and retrieve proven image generation prompts from trending community library",
      fullInstructions: `## Prompt Library — Image Generation Prompt Reference

Multi-action tool for discovering and using proven image generation prompts.

**Actions:**
- \`search\` — Find prompts by keyword/category. Returns previews (first 200 chars).
- \`trending\` — Get top prompts by popularity. Returns previews.
- \`random\` — Get random prompts, optionally filtered by category.
- \`categories\` — List all categories with counts.
- \`get\` — Retrieve full prompt text by ID. Use after finding via search/trending.

**Prompt Enhancement Rules (apply when crafting/adapting prompts):**
${getPromptLibraryRulesSummary()}

**Scene Quick-Reference:**
${getSceneGuideSummary()}

**Prompt Formats:** 44% are structured JSON templates (camera, lighting, mood sections) — ideal for adapting. 56% are natural language.

**Workflow:** search/trending -> pick prompt -> get full text -> adapt/combine with user's intent -> generate.`,
      loading: { deferLoading: true },
      requiresSession: false,
    } satisfies ToolMetadata,
    ({ sessionId }) => createPromptLibraryTool({
      sessionId: sessionId || "UNSCOPED",
    })
  );

  registry.register(
    "askUserQuestion",
    {
      displayName: "Ask User Question",
      category: "utility",
      keywords: [
        "ask",
        "question",
        "user",
        "interactive",
        "clarify",
        "clarification",
        "options",
        "select",
        "multiple choice",
        "preference",
        "choice",
        "confirm",
      ],
      shortDescription:
        "Ask the user interactive questions with selectable options and wait for their response",
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId }) =>
      createAskUserQuestionTool({
        sessionId: sessionId || "UNSCOPED",
      })
  );

  // Chromium Workspace Tool - Embedded browser automation (feature-flagged)
  registry.register(
    "chromiumWorkspace",
    {
      displayName: "Chromium Workspace",
      category: "browser",
      keywords: [
        "browser",
        "chromium",
        "web",
        "navigate",
        "click",
        "type",
        "scrape",
        "extract",
        "screenshot",
        "accessibility",
        "snapshot",
        "page",
        "dom",
        "evaluate",
        "javascript",
        "automation",
        "viewport",
        "responsive",
        "mobile",
        "tablet",
        "orientation",
      ],
      shortDescription:
        "Embedded Chromium browser for web automation — navigate, click, type, extract, evaluate, and test responsive viewports",
      fullInstructions: `## Chromium Workspace

Isolated, embedded browser for web automation. One tool, multiple actions.

**Actions:**
- \`open\`: Start a session and navigate. \`{ action: "open", url: "https://..." }\`
- \`navigate\`: Go to a new URL. \`{ action: "navigate", url: "https://..." }\`
- \`click\`: Click an element. \`{ action: "click", selector: "button.submit" }\`
- \`type\`: Type into an input. \`{ action: "type", selector: "input[name=q]", text: "query" }\`
- \`snapshot\`: Get accessibility tree of the page (structured, token-efficient observation).
- \`extract\`: Get text content from an element. \`{ action: "extract", selector: ".content" }\`
- \`evaluate\`: Run JavaScript in page context. \`{ action: "evaluate", expression: "document.title" }\`
- \`setViewport\`: Set responsive viewport. \`{ action: "setViewport", viewportPreset: "mobile", orientation: "portrait" }\`
- \`resetViewport\`: Reset to default desktop viewport. \`{ action: "resetViewport" }\`
- \`close\`: End session, return execution history summary.

**Responsive viewport controls:** pass \`viewportPreset\`, \`viewportWidth\`, \`viewportHeight\`, \`orientation\`, or \`resetViewport\` directly on \`open\`, \`navigate\`, \`snapshot\`, \`extract\`, \`evaluate\`, \`click\`, or \`type\`; the viewport is applied before the action. Common presets include \`mobile\`, \`iphone-se\`, \`iphone-14\`, \`pixel-7\`, \`tablet\`, \`ipad\`, \`ipad-pro\`, \`desktop\`, and \`desktop-wide\`.

**Workflow:** open → (setViewport/navigate/click/type/snapshot/extract/evaluate)* → close
**Isolation:** Each agent gets its own sandboxed browser context.
**Observation:** Prefer \`snapshot\` over screenshots — structured data, no vision model needed. Tool results include current viewport metadata.`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, characterId }) =>
      createChromiumWorkspaceTool({
        sessionId: sessionId || "UNSCOPED",
        agentId: characterId,
      })
  );

  // Design Workspace Tool - Generate, edit, and export UI components
  registry.register(
    "designWorkspace",
    {
      displayName: "Design Workspace",
      category: "utility",
      keywords: [
        "design",
        "component",
        "ui",
        "generate",
        "preview",
        "tailwind",
        "mockup",
        "card",
        "iterate",
        "inspect",
        "glass",
      ],
      shortDescription:
        "Generate, inspect, and iterate on UI components in the design workspace",
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, userId, characterId }) =>
      createDesignWorkspaceTool({
        sessionId: sessionId || "UNSCOPED",
        userId: userId || "UNSCOPED",
        characterId,
      })
  );

}
