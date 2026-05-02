const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Broad agent filesystem and command access is enabled by default in packaged
 * Electron builds. Other runtimes can opt in with SELENE_UNSAFE_AGENT_PERMISSIONS=true.
 */
export function areUnsafeAgentPermissionsEnabled(): boolean {
  if (process.env.SELENE_PRODUCTION_BUILD === "1") return true;
  return TRUE_VALUES.has((process.env.SELENE_UNSAFE_AGENT_PERMISSIONS ?? "").trim().toLowerCase());
}
