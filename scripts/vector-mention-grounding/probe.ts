/**
 * Vector @-Mention Grounding Probe
 * --------------------------------------------------------------
 * Compares v1 (SQL LIKE on `agent_sync_files.relativePath`) against
 * v2 (hybrid vector search via `searchWithRouter`) using the fixture
 * at ./fixture.json.
 *
 * Run:
 *   npx tsx scripts/vector-mention-grounding/probe.ts
 *
 * Optional env:
 *   LOCAL_DATA_PATH   defaults to "$HOME/Library/Application Support/selene/data"
 *   FIXTURE_PATH      override fixture file
 *   PROBE_TOPK        override topK from fixture
 *
 * Pass criteria per case:
 *   - All paths in `expectIncludes` appear in the top-K relativePaths
 *   - At least one path/substring in `expectAnyOf` appears in the top-K
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";

// ---- env wiring (must happen BEFORE any @/ imports) ----
const HOME = os.homedir();
const DEFAULT_DATA_PATH = path.join(HOME, "Library", "Application Support", "selene", "data");
process.env.LOCAL_DATA_PATH = process.env.LOCAL_DATA_PATH || DEFAULT_DATA_PATH;
process.env.EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || "local";
process.env.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "Xenova/bge-large-en-v1.5";
process.env.EMBEDDING_CACHE_DIR =
  process.env.EMBEDDING_CACHE_DIR || path.join(process.env.LOCAL_DATA_PATH, "transformers-cache");
process.env.ALLOW_LOCAL_EMBEDDINGS = process.env.ALLOW_LOCAL_EMBEDDINGS || "true";

const FIXTURE_PATH =
  process.env.FIXTURE_PATH ||
  path.join(__dirname, "fixture.json");

interface FixtureCase {
  id: string;
  query: string;
  expectIncludes?: string[];
  expectAnyOf?: string[];
}

interface Fixture {
  characterId: string;
  characterName: string;
  folderPath: string;
  topK: number;
  cases: FixtureCase[];
}

interface CaseScore {
  id: string;
  query: string;
  v1Top: string[];
  v2Top: string[];
  v1Includes: number;
  v1AnyOf: boolean;
  v2Includes: number;
  v2AnyOf: boolean;
  expectedIncludes: number;
  hasAnyOf: boolean;
}

function pathMatches(haystack: string[], needle: string): boolean {
  // Exact relative-path equality OR substring containment for partial expectations.
  return haystack.some((h) => h === needle || h.includes(needle));
}

function rankScore(top: string[], expectIncludes: string[], expectAnyOf: string[]) {
  const includes = expectIncludes.filter((e) => pathMatches(top, e)).length;
  const anyOf =
    expectAnyOf.length === 0
      ? true
      : expectAnyOf.some((e) => pathMatches(top, e));
  return { includes, anyOf };
}

async function main() {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  const fixture: Fixture = JSON.parse(raw);
  const TOP_K = Number(process.env.PROBE_TOPK || fixture.topK || 8);

  console.log("==============================================");
  console.log("  Vector @-Mention Grounding Probe");
  console.log("==============================================");
  console.log(`character    : ${fixture.characterName} (${fixture.characterId})`);
  console.log(`folderPath   : ${fixture.folderPath}`);
  console.log(`topK         : ${TOP_K}`);
  console.log(`LOCAL_DATA_PATH=${process.env.LOCAL_DATA_PATH}`);
  console.log(`cases        : ${fixture.cases.length}`);
  console.log();

  // --- ensure vector DB is enabled in settings (mirror embedding-pipeline-test.ts) ---
  const { loadSettings, saveSettings } = await import("../../lib/settings/settings-manager");
  const baseSettings = loadSettings();
  if (!baseSettings.vectorDBEnabled) {
    saveSettings({ ...baseSettings, vectorDBEnabled: true });
    console.log("[probe] forced settings.vectorDBEnabled = true");
  }

  const { db } = await import("../../lib/db/sqlite-client");
  const { agentSyncFiles } = await import("../../lib/db/sqlite-character-schema");
  const { eq, like, and } = await import("drizzle-orm");

  const { searchWithRouter } = await import("../../lib/vectordb");
  const { closeLanceDB } = await import("../../lib/vectordb/client");

  const results: CaseScore[] = [];

  for (const c of fixture.cases) {
    const expectIncludes = c.expectIncludes ?? [];
    const expectAnyOf = c.expectAnyOf ?? [];

    // --- v1: SQL LIKE substring on relativePath ---
    const v1Rows = await db
      .select({ relativePath: agentSyncFiles.relativePath })
      .from(agentSyncFiles)
      .where(
        and(
          eq(agentSyncFiles.characterId, fixture.characterId),
          like(agentSyncFiles.relativePath, `%${c.query}%`)
        )
      )
      .limit(TOP_K);
    const v1Top = v1Rows.map((r) => r.relativePath);

    // --- v2: hybrid vector search (default) ---
    const v2Hits = await searchWithRouter({
      characterId: fixture.characterId,
      query: c.query,
      options: { topK: TOP_K * 2, minScore: 0.01 },
    });
    // Dedupe relativePath, preserving the highest-rank order.
    const v2Top: string[] = [];
    for (const h of v2Hits) {
      if (!v2Top.includes(h.relativePath)) v2Top.push(h.relativePath);
      if (v2Top.length >= TOP_K) break;
    }

    const v1 = rankScore(v1Top, expectIncludes, expectAnyOf);
    const v2 = rankScore(v2Top, expectIncludes, expectAnyOf);

    results.push({
      id: c.id,
      query: c.query,
      v1Top,
      v2Top,
      v1Includes: v1.includes,
      v1AnyOf: v1.anyOf,
      v2Includes: v2.includes,
      v2AnyOf: v2.anyOf,
      expectedIncludes: expectIncludes.length,
      hasAnyOf: expectAnyOf.length > 0,
    });

    console.log(`──────────────────────────────────────────────`);
    console.log(`[${c.id}] "${c.query}"`);
    console.log(`  expectIncludes (${expectIncludes.length}): ${JSON.stringify(expectIncludes)}`);
    console.log(`  expectAnyOf:    ${JSON.stringify(expectAnyOf)}`);
    console.log(`  v1 top ${v1Top.length}: ${JSON.stringify(v1Top.slice(0, 5))}${v1Top.length > 5 ? " …" : ""}`);
    console.log(`  v2 top ${v2Top.length}: ${JSON.stringify(v2Top.slice(0, 5))}${v2Top.length > 5 ? " …" : ""}`);
    console.log(
      `  v1 score: includes ${v1.includes}/${expectIncludes.length}` +
      `  anyOf=${v1.anyOf}` +
      `   |   v2 score: includes ${v2.includes}/${expectIncludes.length}` +
      `  anyOf=${v2.anyOf}`
    );
  }

  // --- aggregate ---
  const totalIncludes = results.reduce((s, r) => s + r.expectedIncludes, 0);
  const v1IncludesHit = results.reduce((s, r) => s + r.v1Includes, 0);
  const v2IncludesHit = results.reduce((s, r) => s + r.v2Includes, 0);
  const v1AnyOfPass = results.filter((r) => r.hasAnyOf && r.v1AnyOf).length;
  const v2AnyOfPass = results.filter((r) => r.hasAnyOf && r.v2AnyOf).length;
  const anyOfTotal = results.filter((r) => r.hasAnyOf).length;
  const v1FullyPass = results.filter(
    (r) => r.v1Includes === r.expectedIncludes && (!r.hasAnyOf || r.v1AnyOf)
  ).length;
  const v2FullyPass = results.filter(
    (r) => r.v2Includes === r.expectedIncludes && (!r.hasAnyOf || r.v2AnyOf)
  ).length;

  console.log();
  console.log("==============================================");
  console.log("  Aggregate");
  console.log("==============================================");
  console.log(`expectIncludes recall  v1=${v1IncludesHit}/${totalIncludes}  v2=${v2IncludesHit}/${totalIncludes}`);
  console.log(`expectAnyOf  pass      v1=${v1AnyOfPass}/${anyOfTotal}  v2=${v2AnyOfPass}/${anyOfTotal}`);
  console.log(`cases fully passing    v1=${v1FullyPass}/${results.length}  v2=${v2FullyPass}/${results.length}`);
  console.log();

  // Exit non-zero only if v2 regresses below v1 — useful for CI gating later.
  const v2Regressed = v2FullyPass < v1FullyPass;
  if (v2Regressed) {
    console.error("[probe] v2 regressed vs v1 — failing.");
  }

  // Persist last-run report for diffing across implementation steps.
  const reportPath = path.join(__dirname, "last-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        characterId: fixture.characterId,
        topK: TOP_K,
        v1IncludesHit,
        v2IncludesHit,
        totalIncludes,
        v1FullyPass,
        v2FullyPass,
        cases: results,
      },
      null,
      2
    )
  );
  console.log(`[probe] wrote ${reportPath}`);

  closeLanceDB();
  process.exit(v2Regressed ? 1 : 0);
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(2);
});
