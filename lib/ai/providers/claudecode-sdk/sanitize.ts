/**
 * Pure sanitization helpers for the Agent SDK Claude Code backend.
 *
 * These guard the request body and SDK tool-name payloads against malformed
 * data before handing them to `@anthropic-ai/claude-agent-sdk`:
 *  - lone UTF-16 surrogates that break JSON serialization,
 *  - malformed `tool_use.input` (non-object / stringified JSON),
 *  - corrupted SDK tool names (MCP prefixes, attribute fragments).
 *
 * No SDK import — kept package-free so it is trivially unit-testable.
 */

export function isDictionary(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeLoneSurrogates(input: string): { value: string; changed: boolean } {
  let changed = false;
  let output = "";

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);

    // Preserve valid surrogate pairs and replace malformed lone surrogates.
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        output += input[i] + input[i + 1];
        i += 1;
      } else {
        output += "�";
        changed = true;
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "�";
      changed = true;
      continue;
    }

    output += input[i];
  }

  return { value: output, changed };
}

/**
 * Recursively replace lone surrogates in every string value of a JSON-like
 * structure. Returns `changed: true` if any replacement occurred.
 */
export function sanitizeJsonStringValues(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    return sanitizeLoneSurrogates(value);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const sanitizedArray = value.map((entry) => {
      const result = sanitizeJsonStringValues(entry);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: sanitizedArray, changed };
  }

  if (value && typeof value === "object") {
    let changed = false;
    const sanitizedObject: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = sanitizeJsonStringValues(entry);
      changed = changed || result.changed;
      sanitizedObject[key] = result.value;
    }
    return { value: sanitizedObject, changed };
  }

  return { value, changed: false };
}

/**
 * Normalize a (possibly corrupted) SDK tool name into a clean leaf name.
 * Strips the Selene MCP server prefix and recovers from malformed payloads
 * (e.g. `name="Tool"` fragments, dangling quotes).
 */
export function normalizeClaudeSdkToolName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Strip the Selene MCP server prefix added by the Claude Agent SDK.
  // e.g. "mcp__selene-platform__calculator" → "calculator".
  // Only strip our own server prefix to avoid cross-server name collisions.
  // Don't return early — the extracted candidate still needs cleanup below
  // in case the SDK payload is malformed (e.g. trailing attribute fragments).
  const mcpPrefixMatch = /^mcp__selene-platform__(.+)$/.exec(trimmed);
  const afterPrefix = mcpPrefixMatch?.[1] ?? trimmed;

  // Some malformed SDK payloads include name="Tool" style fragments.
  const nameAttrMatch = /(?:^|[\s<])name\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(afterPrefix);
  if (nameAttrMatch?.[1]) {
    return nameAttrMatch[1];
  }

  const firstToken = afterPrefix.split(/\s+/)[0] ?? "";
  if (!firstToken) return undefined;

  const unwrapped = firstToken
    .replace(/^["'`<]+/, "")
    .replace(/[>"'`,;]+$/g, "");

  if (!unwrapped) return undefined;

  // Handle dangling-quote corruption like: Task" subagent_type="Explore
  const quoteIndex = unwrapped.search(/["']/);
  const candidate = (quoteIndex >= 0 ? unwrapped.slice(0, quoteIndex) : unwrapped).trim();
  return candidate || undefined;
}

function normalizeToolUseInput(input: unknown): Record<string, unknown> {
  if (isDictionary(input)) {
    return input;
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (isDictionary(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to placeholder object.
    }
  }

  return {
    _recoveredInvalidToolUseInput: true,
    _inputType: input === null ? "null" : Array.isArray(input) ? "array" : typeof input,
  };
}

/**
 * Repair malformed `tool_use.input` values across all messages in an Anthropic
 * Messages request body. Returns the (possibly new) body and how many inputs
 * were fixed.
 */
export function normalizeAnthropicToolUseInputs(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  fixedCount: number;
} {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return { body, fixedCount: 0 };
  }

  let fixedCount = 0;
  const normalizedMessages = messages.map((message) => {
    if (!isDictionary(message) || !Array.isArray(message.content)) {
      return message;
    }

    const normalizedContent = message.content.map((part) => {
      if (!isDictionary(part) || part.type !== "tool_use") {
        return part;
      }

      const normalizedInput = normalizeToolUseInput(part.input);
      if (normalizedInput !== part.input) {
        fixedCount += 1;
      }

      return {
        ...part,
        input: normalizedInput,
      };
    });

    return { ...message, content: normalizedContent };
  });

  return { body: { ...body, messages: normalizedMessages }, fixedCount };
}
