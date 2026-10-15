/**
 * Pure parsing helpers for channel slash commands. Kept dependency-free so
 * they can be unit tested without loading the channel pipeline.
 */

export interface ChannelCommand {
  name: string;
  args: string;
}

/**
 * Parse a channel slash command (`/command` or `!command`, with optional
 * `@botname` suffix). `/list` is normalized to `sessions`.
 * `/new` and `/stop` have dedicated detection helpers because they are
 * handled specially in the inbound pipeline, but `/stop` also parses here.
 */
export function parseChannelCommand(text: string): ChannelCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(
    /^[/!](status|tts|compact|stop|sessions|list|switch|delete|current|help|cancel)(?:@[\w_]+)?(?:\s+(.*))?$/i
  );
  if (!match) return null;
  const name = match[1].toLowerCase();
  return { name: name === "list" ? "sessions" : name, args: (match[2] || "").trim() };
}

export function isStopCommand(text: string): boolean {
  if (!text) return false;
  return /^(?:\/|!)stop(?:@[\w_]+)?$/i.test(text.trim());
}

export function isNewSessionCommand(text: string): boolean {
  if (!text) return false;
  return /^(?:\/|!)new(?:@[\w_]+)?$/i.test(text.trim());
}
