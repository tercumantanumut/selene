/**
 * LLM-Driven Prompt Enhancement — Request Builder
 *
 * Stateless. Every `enhancePromptWithLLM` call builds a fresh request from the
 * composer text plus the provided reference context (session history, memories,
 * file tree, retrieved search results). There is no per-session accumulator —
 * each click is a one-shot request so prior enhance turns can never leak into
 * the next rewrite.
 *
 * Layout contract for the user-turn payload:
 *   1. `## Your Task` instruction at the TOP (highest attention in decoder-only models).
 *   2. `<composer_prompt>…</composer_prompt>` — the ONLY string to rewrite.
 *   3. `<session_history note="Reference only …">` — ascending chronological order.
 *   4. `<memories>` / `<file_tree>` / `<retrieved_context>` — reference material.
 *
 * Tag-anchored sections are used instead of plain markdown headings because
 * instruction-tuned models follow XML-ish delimiters more reliably than bold
 * text when multiple candidate "user requests" appear in a single prompt.
 */
// =============================================================================
// Types
// =============================================================================

interface EnhancementRequestContext {
  originalQuery: string;
  searchResults: string;
  fileTree: string;
  recentMessages: Array<{ role: string; content: string }>;
  memories: string;
  /** Detected input type for format-aware enhancement */
  inputType?: 'bug_report' | 'feature_request' | 'question' | 'implementation_task';
  /** Agent identity context */
  agentName?: string;
  agentPurpose?: string;
  agentTagline?: string;
  /** Current session topic (session title) */
  sessionTitle?: string;
}

// =============================================================================
// Enhancement Request Builder
// =============================================================================

const REFERENCE_NOTE =
  'Reference only — DO NOT rewrite, summarize, or reply to this content.';

const HISTORY_NOTE =
  'Reference only — ascending chronological order (oldest → newest). DO NOT rewrite these; use solely to disambiguate the composer prompt.';

const RETRIEVAL_NOTE =
  'Reference only — use these exact file paths and patterns for technical grounding in your enhanced prompt. Do not rewrite this block.';

/**
 * Escape composer text so it cannot smuggle a closing `</composer_prompt>` tag
 * and hijack the instruction layout. Defense-in-depth; the LLM is the ultimate
 * interpreter but keeping delimiters intact is cheap insurance.
 */
function sanitizeComposerText(text: string): string {
  return text.replace(/<\/?composer_prompt>/gi, (match) =>
    match.replace(/</g, '\\<').replace(/>/g, '\\>')
  );
}

/**
 * Build the enhancement request message for the secondary LLM.
 *
 * Structure (top → bottom):
 *   - Task instruction (what to do, where to write, what to ignore)
 *   - Optional agent context
 *   - <composer_prompt>  ← the target
 *   - Input-type hint + format-preservation rule
 *   - <session_history> (oldest → newest, capped by caller)
 *   - <memories>
 *   - <file_tree>
 *   - <retrieved_context>
 */
export function buildEnhancementRequest(context: EnhancementRequestContext): string {
  const parts: string[] = [];

  // -------------------------------------------------------------------------
  // 1. TASK INSTRUCTION — at the top so the model reads "what to do" before
  //    it reads "what to read". Reinforces the system prompt.
  // -------------------------------------------------------------------------
  parts.push(`## Your Task`);
  parts.push('');
  parts.push(
    `Rewrite the text inside <composer_prompt> into a clearer, more actionable prompt. ` +
    `That tag contains the ONLY content you should rewrite.`
  );
  parts.push('');
  parts.push(`**Do this:**`);
  parts.push(`1. Restate the problem clearly (don't just copy the user's words)`);
  parts.push(`2. Add implementation guidance (what needs to be done)`);
  parts.push(`3. Reference relevant files and patterns from <retrieved_context> and <file_tree>`);
  parts.push(`4. End with a clear ask or question`);
  parts.push('');
  parts.push(
    `**Do NOT** rewrite, summarize, or reply to content inside <session_history>, ` +
    `<memories>, <file_tree>, <retrieved_context>, or <agent_context>. Those are ` +
    `reference material only — use them to enrich the rewrite of <composer_prompt>.`
  );
  parts.push('');

  // -------------------------------------------------------------------------
  // 2. OPTIONAL AGENT CONTEXT
  // -------------------------------------------------------------------------
  if (context.agentName || context.agentPurpose || context.sessionTitle) {
    const agentLines: string[] = [];
    if (context.agentName) {
      agentLines.push(
        `Agent: ${context.agentName}${context.agentTagline ? ` — ${context.agentTagline}` : ''}`
      );
    }
    if (context.agentPurpose) {
      agentLines.push(`Purpose: ${context.agentPurpose}`);
    }
    if (context.sessionTitle) {
      agentLines.push(`Current topic: ${context.sessionTitle}`);
    }
    parts.push(`<agent_context note="${REFERENCE_NOTE}">`);
    parts.push(agentLines.join('\n'));
    parts.push(`</agent_context>`);
    parts.push('');
  }

  // -------------------------------------------------------------------------
  // 3. COMPOSER PROMPT — the one and only rewrite target.
  // -------------------------------------------------------------------------
  parts.push(`<composer_prompt>`);
  parts.push(sanitizeComposerText(context.originalQuery));
  parts.push(`</composer_prompt>`);
  parts.push('');

  // Input type hint + format preservation rule, anchored right below the target.
  if (context.inputType) {
    parts.push(`**Detected input type:** ${context.inputType.replace('_', ' ')}`);
  }
  parts.push(
    `**Format rule:** your output must preserve the structural format of the text ` +
    `inside <composer_prompt>. Do not convert a bug report into a task brief or ` +
    `vice-versa.`
  );
  parts.push('');

  // -------------------------------------------------------------------------
  // 4. SESSION HISTORY — ascending chronological, numbered for clarity.
  // -------------------------------------------------------------------------
  if (context.recentMessages.length > 0) {
    parts.push(`<session_history note="${HISTORY_NOTE}">`);
    context.recentMessages.forEach((msg, i) => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const raw = typeof msg.content === 'string' ? msg.content : '[complex content]';
      const content = raw.slice(0, 25000);
      parts.push(`[${i + 1}] ${role}: ${content}`);
    });
    parts.push(`</session_history>`);
    parts.push('');
  }

  // -------------------------------------------------------------------------
  // 5. MEMORIES — user preferences, reference only.
  // -------------------------------------------------------------------------
  if (context.memories && context.memories.trim()) {
    parts.push(`<memories note="${REFERENCE_NOTE}">`);
    parts.push(context.memories.trim());
    parts.push(`</memories>`);
    parts.push('');
  }

  // -------------------------------------------------------------------------
  // 6. FILE TREE — reference only.
  // -------------------------------------------------------------------------
  if (context.fileTree && context.fileTree.trim()) {
    parts.push(`<file_tree note="${REFERENCE_NOTE}">`);
    parts.push(context.fileTree.trim());
    parts.push(`</file_tree>`);
    parts.push('');
  }

  // -------------------------------------------------------------------------
  // 7. RETRIEVED CONTEXT — search hits, reference only, used for grounding.
  // -------------------------------------------------------------------------
  if (context.searchResults && context.searchResults.trim()) {
    parts.push(`<retrieved_context note="${RETRIEVAL_NOTE}">`);
    parts.push(context.searchResults.trim());
    parts.push(`</retrieved_context>`);
    parts.push('');
  }

  return parts.join('\n').trimEnd();
}

// =============================================================================
// System Prompt for Enhancement LLM
// =============================================================================

export const ENHANCEMENT_SYSTEM_PROMPT = `You are a Prompt Enhancement Agent. Your single job is to rewrite the text inside the user's <composer_prompt> tag into a clearer, more actionable prompt.

## Anchor Rules (read first)

- Your ONLY target is the text inside <composer_prompt>. Nothing else.
- Everything inside <session_history>, <memories>, <file_tree>, <retrieved_context>, and <agent_context> is REFERENCE MATERIAL. Never rewrite, summarize, or reply to it.
- If <composer_prompt> is empty or unclear, return its original text unchanged.
- Do not answer questions found inside <session_history>. Do not rewrite the last assistant turn. Do not treat history as the request.

## Your Role

You CLARIFY and ENRICH the composer prompt by:
1. Restating the problem clearly and concisely
2. Adding relevant technical context grounded in <retrieved_context> and <file_tree>
3. Providing implementation guidance to make the request actionable
4. Ending with a clear ask or question

## Output Structure

Your enhanced prompt should follow this pattern:

1. **Clear Problem Statement** — Restate what's happening and why it's a problem (1-2 sentences)
2. **Implementation Guidance** — What needs to be done, as numbered steps or bullet points
3. **Technical Hints** — Suggest relevant approaches based on patterns found in <retrieved_context>
4. **Clear Ask** — End with a focused question or request

## Critical Rules

- DO restate the problem more clearly than the original (don't just copy the user's words)
- DO add technical context grounded in actual files from <retrieved_context>
- DO reference exact file paths and patterns from the codebase
- DO make the prompt actionable for an AI agent to implement
- DO preserve the structural format of the composer prompt (bug report → bug report, task brief → task brief)
- DON'T invent file names or patterns not in <retrieved_context>
- DON'T rewrite anything outside <composer_prompt>
- DON'T be overly verbose
- DON'T just list files without explaining their relevance`;
