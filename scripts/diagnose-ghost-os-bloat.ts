#!/usr/bin/env tsx
/**
 * Ghost OS MCP context-bloat diagnostic.
 *
 * Connects directly to the Ghost OS MCP server (macOS only), calls a small
 * set of screenshot / perception tools, and measures the byte + approximate
 * token cost of the result BEFORE and AFTER it passes through Selene's
 * `formatMCPToolResult` sanitizer.
 *
 * Use it to confirm:
 *   1. Exactly what content-block shape Ghost OS emits for images.
 *   2. Whether `formatMCPToolResult` actually strips the base64 (or not).
 *   3. The residual size that reaches the DB (canonical, lossless) history.
 *
 * Usage:
 *   npx tsx scripts/diagnose-ghost-os-bloat.ts
 *   npx tsx scripts/diagnose-ghost-os-bloat.ts --tools=ghost_screenshot,ghost_read
 *   npx tsx scripts/diagnose-ghost-os-bloat.ts --dump=full    # print full formatted JSON
 *
 * NOTE: this script mutates nothing. It writes its captured images to the
 * local media store via `saveBase64Image` only as a side effect of the
 * real sanitizer path — that is the behavior under test.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveGhostBinary } from "@/lib/ghost-os/setup";
import { formatMCPToolResult } from "@/lib/mcp/result-formatter";
import { stubEphemeralToolResults } from "@/app/api/chat/canonical-content";
import type { DBContentPart } from "@/lib/messages/converter";

// -----------------------------------------------------------------------------
// CLI args
// -----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const dumpMode = argv.includes("--dump=full") ? "full" : "preview";
const toolsArg = argv.find((a) => a.startsWith("--tools="))?.split("=")[1];
const REQUESTED_TOOLS = toolsArg
    ? toolsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : ["ghost_screenshot", "ghost_read", "ghost_parse_screen"];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const SESSION_ID = `bloat-diag-${Date.now()}`;

function bytes(v: unknown): number {
    return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
}

/** Cheap token estimate; good enough for before/after deltas (~4 chars/token). */
function approxTokens(byteLen: number): number {
    return Math.round(byteLen / 4);
}

/** Detect embedded base64 regardless of `data:` prefix. */
function scanForBase64(v: unknown): { dataUrls: number; rawRuns: number; longestRun: number } {
    const json = JSON.stringify(v) ?? "";
    const dataUrls = (json.match(/data:[^"\\]{10,};base64,[A-Za-z0-9+/=]{100,}/g) ?? []).length;
    const rawRuns = (json.match(/[A-Za-z0-9+/=]{500,}/g) ?? []).length;
    const longestRun = (json.match(/[A-Za-z0-9+/=]+/g) ?? [])
        .reduce((max, run) => Math.max(max, run.length), 0);
    return { dataUrls, rawRuns, longestRun };
}

/** Shallow+bounded shape description so we can SEE where base64 lives. */
function summarizeShape(v: unknown, depth = 0): string {
    if (depth > 3) return "…";
    if (v === null) return "null";
    if (Array.isArray(v)) {
        const peek = v.slice(0, 2).map((x) => summarizeShape(x, depth + 1)).join(", ");
        return `Array(${v.length})[${peek}${v.length > 2 ? ", …" : ""}]`;
    }
    if (typeof v === "object") {
        const obj = v as Record<string, unknown>;
        const keys = Object.keys(obj);
        const inner = keys
            .slice(0, 6)
            .map((k) => `${k}: ${summarizeShape(obj[k], depth + 1)}`)
            .join(", ");
        return `{${inner}${keys.length > 6 ? ", …" : ""}}`;
    }
    if (typeof v === "string") {
        if (v.startsWith("data:")) return `"data:…(${v.length}ch)"`;
        if (v.length > 200 && /^[A-Za-z0-9+/=]+$/.test(v)) return `"rawB64?…(${v.length}ch)"`;
        if (v.length > 120) return `"${v.slice(0, 60)}…(${v.length}ch)"`;
        return JSON.stringify(v);
    }
    return String(v);
}

function preview(v: unknown, max = 600): string {
    const s = JSON.stringify(v, null, 2) ?? "";
    return s.length > max ? `${s.slice(0, max)}\n…(${s.length - max} more chars)` : s;
}

function line(ch = "─", n = 72): string {
    return ch.repeat(n);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main(): Promise<number> {
    if (process.platform !== "darwin") {
        console.error("[bloat] Ghost OS is macOS-only. Current platform:", process.platform);
        return 1;
    }

    const binaryPath = await resolveGhostBinary();
    if (!binaryPath) {
        console.error("[bloat] Ghost OS binary not found. Install via `brew install ghost-os` and retry.");
        return 1;
    }
    console.log(`[bloat] Ghost OS binary: ${binaryPath}`);
    console.log(`[bloat] Session id:      ${SESSION_ID}`);
    console.log(`[bloat] Tools to test:   ${REQUESTED_TOOLS.join(", ")}`);

    const transport = new StdioClientTransport({
        command: binaryPath,
        args: ["mcp"],
    });
    const client = new Client({ name: "selene-ghost-os-bloat-diag", version: "0.0.1" });

    try {
        await client.connect(transport);
    } catch (err) {
        console.error("[bloat] Failed to connect to ghost-os MCP:", err);
        return 1;
    }

    const { tools: available } = await client.listTools();
    const availableNames = new Set(available.map((t) => t.name));
    console.log(`[bloat] Server exposes ${available.length} tools.`);

    const report: Array<{
        tool: string;
        rawBytes: number;
        formattedBytes: number;
        stubbedBytes: number;
        rawScan: ReturnType<typeof scanForBase64>;
        formattedScan: ReturnType<typeof scanForBase64>;
    }> = [];

    for (const toolName of REQUESTED_TOOLS) {
        if (!availableNames.has(toolName)) {
            console.log(`\n[bloat] [skip] ${toolName} not exposed by server.`);
            continue;
        }

        console.log(`\n${line("═")}`);
        console.log(`TOOL: ${toolName}`);
        console.log(line("═"));

        let raw: unknown;
        try {
            raw = await client.callTool({ name: toolName, arguments: {} });
        } catch (err) {
            console.error(`[bloat] Call to ${toolName} failed:`, err);
            continue;
        }

        const rawBytes = bytes(raw);
        const rawScan = scanForBase64(raw);
        console.log("── RAW (straight from MCP SDK) ──");
        console.log(`bytes: ${rawBytes.toLocaleString()}    approx tokens: ~${approxTokens(rawBytes).toLocaleString()}`);
        console.log(`base64 signals → data-url blocks: ${rawScan.dataUrls}   raw-base64 runs ≥500ch: ${rawScan.rawRuns}   longest run: ${rawScan.longestRun}ch`);
        console.log(`shape: ${summarizeShape(raw)}`);
        if (dumpMode === "full") {
            console.log("raw JSON:");
            console.log(preview(raw, 4000));
        } else {
            console.log(`sample:\n${preview(raw, 500)}`);
        }

        let formatted: unknown;
        try {
            formatted = await formatMCPToolResult(
                "ghostos",
                toolName,
                raw,
                false,
                { sessionId: SESSION_ID }
            );
        } catch (err) {
            console.error(`[bloat] formatMCPToolResult threw for ${toolName}:`, err);
            continue;
        }

        const formattedBytes = bytes(formatted);
        const formattedScan = scanForBase64(formatted);
        const saved = rawBytes > 0 ? ((1 - formattedBytes / rawBytes) * 100) : 0;
        console.log("\n── POST formatMCPToolResult (what hits canonical history) ──");
        console.log(`bytes: ${formattedBytes.toLocaleString()}    approx tokens: ~${approxTokens(formattedBytes).toLocaleString()}    saved: ${saved.toFixed(1)}%`);
        console.log(`base64 signals → data-url blocks: ${formattedScan.dataUrls}   raw-base64 runs ≥500ch: ${formattedScan.rawRuns}   longest run: ${formattedScan.longestRun}ch`);
        console.log(`shape: ${summarizeShape(formatted)}`);
        if (dumpMode === "full") {
            console.log("formatted JSON:");
            console.log(preview(formatted, 4000));
        } else {
            console.log(`sample:\n${preview(formatted, 500)}`);
        }

        // ── Simulate canonical-write stubbing (Option B: ephemeralResults honored) ──
        // Wrap the formatted result in a DBToolResultPart as stream-callbacks
        // would, then run stubEphemeralToolResults with a synthetic lookup that
        // marks every MCP tool ephemeral (matches real metadata set by
        // mcp-tool-adapter.ts at registration time).
        const partForPersistence: DBContentPart = {
            type: "tool-result",
            toolCallId: `diag-${toolName}`,
            toolName: `mcp_ghostos_${toolName}`,
            result: formatted,
            status: (formatted as Record<string, unknown>).status as string ?? "success",
            state: "output-available",
            timestamp: new Date().toISOString(),
        };
        const [stubbed] = stubEphemeralToolResults([partForPersistence], () => true);
        const stubbedBytes = bytes(stubbed);
        const savedVsRaw = rawBytes > 0 ? ((1 - stubbedBytes / rawBytes) * 100) : 0;
        const savedVsFmt = formattedBytes > 0 ? ((1 - stubbedBytes / formattedBytes) * 100) : 0;
        console.log("\n── POST stubEphemeralToolResults (what ACTUALLY lands in DB after fix) ──");
        console.log(`bytes: ${stubbedBytes.toLocaleString()}    approx tokens: ~${approxTokens(stubbedBytes).toLocaleString()}    saved vs raw: ${savedVsRaw.toFixed(1)}%    saved vs fmt: ${savedVsFmt.toFixed(1)}%`);
        console.log(`shape: ${summarizeShape(stubbed)}`);
        if (dumpMode === "full") {
            console.log("stub JSON:");
            console.log(preview(stubbed, 2000));
        } else {
            console.log(`sample:\n${preview(stubbed, 400)}`);
        }

        report.push({ tool: toolName, rawBytes, formattedBytes, stubbedBytes, rawScan, formattedScan });
    }

    await client.close().catch(() => {});

    console.log(`\n${line("═")}`);
    console.log("SUMMARY");
    console.log(line("═"));
    console.log(
        [
            "tool".padEnd(22),
            "raw bytes".padStart(12),
            "fmt bytes".padStart(12),
            "stub bytes".padStart(12),
            "raw→stub".padStart(10),
            "b64-left".padStart(10),
            "longest-left".padStart(14),
        ].join("  ")
    );
    for (const r of report) {
        const rawToStub = r.rawBytes > 0 ? ((1 - r.stubbedBytes / r.rawBytes) * 100).toFixed(2) + "%" : "n/a";
        const b64Left = r.formattedScan.dataUrls + r.formattedScan.rawRuns;
        console.log(
            [
                r.tool.padEnd(22),
                r.rawBytes.toLocaleString().padStart(12),
                r.formattedBytes.toLocaleString().padStart(12),
                r.stubbedBytes.toLocaleString().padStart(12),
                rawToStub.padStart(10),
                String(b64Left).padStart(10),
                String(r.formattedScan.longestRun).padStart(14),
            ].join("  ")
        );
    }

    const leaks = report.filter((r) => r.formattedScan.rawRuns > 0 || r.formattedScan.dataUrls > 0);
    if (leaks.length > 0) {
        console.log(`\n[bloat] LEAK DETECTED: ${leaks.map((l) => l.tool).join(", ")} still contain base64 after formatMCPToolResult.`);
        console.log("[bloat] Run with --dump=full to inspect the exact JSON shape.");
    } else {
        console.log("\n[bloat] No residual base64 detected in formatted results.");
        console.log("[bloat] Remaining bloat (if any) comes from the replay path in content-extractor.ts re-inlining /api/media URLs.");
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error("[bloat] FATAL:", err);
        process.exit(1);
    });
