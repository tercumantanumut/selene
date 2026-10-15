/**
 * MCP config resolution: environment variable expansion, synced-folder injection,
 * and filesystem-server auto-path attachment.
 *
 * Extracted from client-manager.ts to keep the manager focused on connection lifecycle.
 */

import { getAllSyncFolders, getSyncFolders, getPrimarySyncFolder } from "@/lib/vectordb/sync-service";
import path from "path";
import type { MCPServerConfig, ResolvedMCPServer } from "./types";

// ── Path validation ───────────────────────────────────────────────────────────

function validateFolderPath(folderPath: string): boolean {
    const resolved = path.resolve(folderPath);
    const allowedBases = [
        process.env.USER_DATA_DIR,
        "/app/data",
        process.env.HOME // For local development compatibility
    ].filter(Boolean) as string[];

    return allowedBases.some(base => resolved.startsWith(path.resolve(base)));
}

function isFilesystemPathArg(arg: string): boolean {
    if (!arg || arg.startsWith("-")) return false;
    if (arg === "@modelcontextprotocol/server-filesystem" || arg === "server-filesystem") return false;
    if (arg.startsWith("http://") || arg.startsWith("https://")) return false;
    return true; // includes synced-folder variables and real paths
}

export function hasFilesystemPathArg(args?: string[]): boolean {
    if (!args || args.length === 0) return false;
    return args.some(isFilesystemPathArg);
}

// ── Config resolver ───────────────────────────────────────────────────────────

/**
 * Resolve environment variables and determine transport type in MCP config.
 * Supports ${SYNCED_FOLDER} (primary) and ${SYNCED_FOLDERS} (all, comma-separated).
 */
export async function resolveMCPConfig(
    serverName: string,
    config: MCPServerConfig,
    env: Record<string, string>,
    characterId?: string
): Promise<ResolvedMCPServer> {
    console.log(`[MCP] Resolving config for ${serverName}:`, {
        hasCharacterId: !!characterId,
        configArgs: config.args,
    });

    const getMcpFolders = async () =>
        characterId ? await getSyncFolders(characterId) : await getAllSyncFolders();

    const resolveValue = async (value: string): Promise<string> => {
        let resolved = value;

        // Handle ${SYNCED_FOLDER} - primary folder only
        if (resolved.includes("${SYNCED_FOLDER}")) {
            const primaryFolder = characterId
                ? await getPrimarySyncFolder(characterId)
                : (await getAllSyncFolders()).find(f => f.isPrimary);
            const primaryPath = primaryFolder?.folderPath || "";

            if (!primaryPath) {
                throw new Error(
                    "Cannot resolve ${SYNCED_FOLDER}: No synced folders found. " +
                    `Please sync a folder in Settings → Synced Folders.`
                );
            }

            if (!validateFolderPath(primaryPath)) {
                throw new Error(`Invalid folder path: ${primaryPath}`);
            }

            resolved = resolved.replace(/\$\{SYNCED_FOLDER\}/g, primaryPath);
        }

        // Handle ${SYNCED_FOLDERS} - all folders, comma-separated (for single-arg tools)
        if (resolved.includes("${SYNCED_FOLDERS}")) {
            const folders = await getMcpFolders();

            if (folders.length === 0) {
                throw new Error("Cannot resolve ${SYNCED_FOLDERS}: No synced folders found.");
            }

            for (const folder of folders) {
                if (!validateFolderPath(folder.folderPath)) {
                    throw new Error(`Invalid folder path in list: ${folder.folderPath}`);
                }
            }

            const allPaths = folders.map(f => f.folderPath).join(",");
            resolved = resolved.replace(/\$\{SYNCED_FOLDERS\}/g, allPaths);
        }

        // Handle standard environment variables
        return resolved.replace(/\$\{([^}]+)\}/g, (_, varName) => env[varName] || "");
    };

    // Determine transport type
    const transportType: "http" | "sse" | "stdio" = config.command
        ? "stdio"
        : (config.type || "sse");

    if (transportType === "stdio") {
        const resolvedEnv: Record<string, string> = {};
        if (config.env) {
            for (const [key, value] of Object.entries(config.env)) {
                resolvedEnv[key] = await resolveValue(value);
            }
        }

        // Resolve arguments with special handling for ${SYNCED_FOLDERS_ARRAY}
        let resolvedArgs: string[] = [];
        if (config.args) {
            for (const arg of config.args) {
                if (arg === "${SYNCED_FOLDERS_ARRAY}") {
                    const folders = await getMcpFolders();

                    if (folders.length === 0) {
                        throw new Error("Cannot resolve ${SYNCED_FOLDERS_ARRAY}: No synced folders found.");
                    }

                    for (const folder of folders) {
                        if (!validateFolderPath(folder.folderPath)) {
                            throw new Error(`Invalid folder path in expansion: ${folder.folderPath}`);
                        }
                    }

                    const paths = folders.map(f => f.folderPath);
                    console.log(`[MCP] Expanding ${arg} to ${paths.length} directories`);
                    resolvedArgs.push(...paths); // Multi-arg expansion!
                } else {
                    resolvedArgs.push(await resolveValue(arg));
                }
            }
        }

        // Second pass: resolve remaining synced-folder variables in expanded args
        {
            const hasVariables = resolvedArgs.some(arg =>
                arg?.includes("${SYNCED_FOLDER}") ||
                arg?.includes("${SYNCED_FOLDERS_ARRAY}") ||
                arg?.includes("${SYNCED_FOLDERS}")
            );

            if (hasVariables) {
                const folders = await getMcpFolders();
                const primaryFolder = folders.find(f => f.isPrimary)?.folderPath || folders[0]?.folderPath || "";

                const newArgs: string[] = [];
                for (const arg of resolvedArgs) {
                    if (arg === "${SYNCED_FOLDER}") {
                        if (!primaryFolder) throw new Error("Cannot resolve ${SYNCED_FOLDER}: No synced folders found.");
                        newArgs.push(primaryFolder);
                    } else if (arg === "${SYNCED_FOLDERS_ARRAY}") {
                        if (folders.length === 0) throw new Error("Cannot resolve ${SYNCED_FOLDERS_ARRAY}: No synced folders found.");
                        newArgs.push(...folders.map(f => f.folderPath));
                    } else if (arg === "${SYNCED_FOLDERS}") {
                        if (folders.length === 0) throw new Error("Cannot resolve ${SYNCED_FOLDERS}: No synced folders found.");
                        newArgs.push(folders.map(f => f.folderPath).join(","));
                    } else {
                        newArgs.push(arg);
                    }
                }
                resolvedArgs = newArgs;
                console.log(`[MCP] Resolved synced folder variables for ${serverName}`);
            }
        }

        // Auto-inject paths for filesystem servers if still missing
        if (serverName === "filesystem" || serverName === "filesystem-multi") {
            const needsAutoPaths = !hasFilesystemPathArg(resolvedArgs);
            if (needsAutoPaths) {
                const folders = await getMcpFolders();
                if (folders.length === 0) {
                    throw new Error("Cannot resolve filesystem MCP paths: No synced folders found.");
                }

                const paths = serverName === "filesystem"
                    ? [folders.find(f => f.isPrimary)?.folderPath || folders[0].folderPath]
                    : folders.map(f => f.folderPath);

                for (const folderPath of paths) {
                    if (!validateFolderPath(folderPath)) {
                        throw new Error(`Invalid folder path in auto-attach: ${folderPath}`);
                    }
                }

                resolvedArgs.push(...paths);
                console.log(`[MCP] Auto-attached ${paths.length} synced folder(s) for ${serverName}`);
            }
        }

        console.log(`[MCP] ✅ Resolved ${serverName}:`, {
            command: config.command,
            args: resolvedArgs,
            env: Object.keys(resolvedEnv),
        });

        return {
            name: serverName,
            type: "stdio",
            command: config.command ? await resolveValue(config.command) : undefined,
            args: resolvedArgs,
            env: resolvedEnv,
            auth: config.auth,
            timeout: config.timeout || 30000,
        };
    }

    // HTTP/SSE transport
    const resolvedHeaders: Record<string, string> = {};
    if (config.headers) {
        for (const [key, value] of Object.entries(config.headers)) {
            resolvedHeaders[key] = await resolveValue(value);
        }
    }

    return {
        name: serverName,
        type: transportType,
        url: config.url ? await resolveValue(config.url) : undefined,
        headers: resolvedHeaders,
        auth: config.auth,
        timeout: config.timeout || 30000,
    };
}
