import * as esbuild from "esbuild";

const isDev = process.argv.includes("--dev");

// Bundle the Electron main process
// Native modules must stay external (they contain .node binaries that can't
// be bundled). Transformers.js is resolved by lib/ai/transformers-runtime.ts
// from standalone/node_modules in packaged builds so the startup bundle stays
// small without relying on Node's fragile package ESM resolver from app.asar.
// ---------------------------------------------------------------------------
// Banner: native module resolution for packaged builds
// This MUST run before any require() in the bundle because esbuild evaluates
// inlined dependency code (which calls require('onnxruntime-node')) BEFORE
// the entry point code in main.ts. Without this banner, the globalPaths fix
// in main.ts runs too late and the require fails inside the asar.
// ---------------------------------------------------------------------------
const nativeModuleBanner = `
(function() {
  try {
    var _app = require("electron").app;
    if (_app && !_app.isPackaged) return; // dev mode — node_modules on disk, no fix needed
    var _path = require("path");
    var _fs = require("fs");
    var _Module = require("module");
    var _standalone = _path.join(process.resourcesPath || "", "standalone", "node_modules");
    if (_fs.existsSync(_standalone)) {
      // Add to NODE_PATH and re-init so require() finds native modules in standalone/
      process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + _path.delimiter : "") + _standalone;
      _Module._initPaths();
      console.log("[NativeModules] Added standalone node_modules to resolution path:", _standalone);
    } else {
      console.warn("[NativeModules] standalone node_modules not found at:", _standalone);
    }
  } catch(e) {
    console.warn("[NativeModules] Banner bootstrap failed:", e.message);
  }
})();
`.trim();

await esbuild.build({
  entryPoints: ["electron/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: "electron-dist/main.js",
  format: "cjs",
  sourcemap: isDev ? "inline" : false,
  minify: !isDev,
  banner: { js: nativeModuleBanner },
  external: [
    // Electron is provided by the runtime
    "electron",
    // Native modules must stay external (they're rebuilt for Electron)
    "better-sqlite3",
    "onnxruntime-node",
    "sharp",
    "@lancedb/*",
    "@huggingface/transformers",
    "@huggingface/hub",
    "gpt-tokenizer",
    "pdf-parse",
    "pdfjs-dist",
    "@anthropic-ai/claude-agent-sdk",
  ],
  define: {
    "process.env.NODE_ENV": isDev ? '"development"' : '"production"',
  },
  logLevel: "info",
});

// Bundle preload script separately
// Preload has access to Node.js APIs but runs in renderer context
await esbuild.build({
  entryPoints: ["electron/preload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: "electron-dist/preload.js",
  format: "cjs",
  sourcemap: isDev ? "inline" : false,
  minify: !isDev,
  external: ["electron"],
  logLevel: "info",
});

console.log("Electron build complete");
