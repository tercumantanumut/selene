// Analyze the electron main bundle WITHOUT touching electron-dist/main.js.
//
// Builds a metafile-instrumented copy of the same esbuild config used by
// esbuild.electron.mjs into /tmp, then prints the top packages by inline
// bytes plus chains for any heavy package that should probably be external.
//
// Usage:
//   npm run analyze:electron-bundle
//   node scripts/analyze-electron-bundle.mjs --imports=ai,zod
//
// Flags:
//   --imports=<csv>   Show first-party files that import each listed pkg
//                     and the import kind (static vs dynamic-import).
//   --top=<n>         Top N packages to print (default 30).
//   --no-minify-est   Skip the post-minify size estimate (faster).

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const TOP = Number(argv.top ?? 30);
const IMPORT_TARGETS = (argv.imports ?? "").split(",").filter(Boolean);
const RUN_MIN = argv["no-minify-est"] !== "true";

// Mirror esbuild.electron.mjs externals so the analysis reflects reality.
const EXTERNAL = [
  "electron",
  "better-sqlite3",
  "onnxruntime-node",
  "sharp",
  "@lancedb/*",
  "@huggingface/hub",
  "@huggingface/transformers",
  "gpt-tokenizer",
  "pdfjs-dist",
  "pdf-parse",
];

console.log("→ Building metafile copy to /tmp/main-analysis.js (no minify)...");
const t0 = Date.now();
const result = await esbuild.build({
  entryPoints: ["electron/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: "/tmp/main-analysis.js",
  format: "cjs",
  sourcemap: false,
  minify: false,
  metafile: true,
  external: EXTERNAL,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
});

fs.writeFileSync("/tmp/main-meta.json", JSON.stringify(result.metafile, null, 2));
const unminBytes = fs.statSync("/tmp/main-analysis.js").size;
console.log(`  metafile written, unminified bundle = ${(unminBytes / 1024 / 1024).toFixed(2)} MB (${Date.now() - t0} ms)`);

let minBytes = null;
if (RUN_MIN) {
  console.log("→ Estimating minified size to /tmp/main-analysis-min.js...");
  const t1 = Date.now();
  await esbuild.build({
    entryPoints: ["electron/main.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    outfile: "/tmp/main-analysis-min.js",
    format: "cjs",
    sourcemap: false,
    minify: true,
    external: EXTERNAL,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  });
  minBytes = fs.statSync("/tmp/main-analysis-min.js").size;
  console.log(`  minified estimate = ${(minBytes / 1024 / 1024).toFixed(2)} MB (${Date.now() - t1} ms)`);
}

// Aggregate by package
const inputs = result.metafile.inputs;
const byPkg = new Map();
for (const [p, info] of Object.entries(inputs)) {
  let key;
  const nm = p.indexOf("node_modules/");
  if (nm !== -1) {
    const after = p.slice(nm + "node_modules/".length);
    key = after.startsWith("@")
      ? "node_modules/" + after.split("/").slice(0, 2).join("/")
      : "node_modules/" + after.split("/")[0];
  } else {
    key = p.split("/")[0];
  }
  byPkg.set(key, (byPkg.get(key) || 0) + info.bytes);
}

const sorted = [...byPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
console.log(`\n=== Top ${TOP} packages by inlined input bytes ===\n`);
for (const [pkg, bytes] of sorted) {
  console.log("  " + (bytes / 1024).toFixed(1).padStart(9) + " KB   " + pkg);
}

// Compare against the real electron-dist if it exists
const realPath = path.resolve("electron-dist/main.js");
if (fs.existsSync(realPath)) {
  const realBytes = fs.statSync(realPath).size;
  console.log(`\n=== electron-dist/main.js on disk: ${(realBytes / 1024 / 1024).toFixed(2)} MB ===`);
  if (minBytes !== null) {
    const delta = realBytes - minBytes;
    const sign = delta >= 0 ? "+" : "";
    console.log(`    vs current esbuild config (minified estimate): ${sign}${(delta / 1024 / 1024).toFixed(2)} MB`);
    console.log("    Run npm run electron:bundle to refresh on-disk bundle.");
  }
}

// Optional import-chain forensics
if (IMPORT_TARGETS.length) {
  console.log(`\n=== Import chains for: ${IMPORT_TARGETS.join(", ")} ===`);
  for (const cand of IMPORT_TARGETS) {
    console.log("\n--- " + cand + " ---");
    const importers = new Map();
    for (const [p, info] of Object.entries(inputs)) {
      if (p.startsWith("node_modules/")) continue;
      for (const imp of info.imports || []) {
        const t = imp.path || "";
        const isMatch =
          t === cand ||
          t.startsWith(cand + "/") ||
          t.startsWith("node_modules/" + cand + "/") ||
          t === "node_modules/" + cand + "/index.js";
        if (!isMatch) continue;
        const key = p + "|" + imp.kind;
        if (!importers.has(key)) importers.set(key, imp);
      }
    }
    if (importers.size === 0) {
      console.log("  (no first-party importers in graph — already external or unreachable)");
      continue;
    }
    for (const [key, imp] of importers) {
      const [p, kind] = key.split("|");
      console.log("  " + kind.padEnd(18) + " " + p + " → " + imp.path);
    }
  }
}

console.log("\nDone. Metafile retained at /tmp/main-meta.json for further forensics.");
