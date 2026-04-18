const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Cross-platform script to prepare the Electron build.
 * Handles missing 'public' folder and ensures directory structure.
 */

const rootDir = process.cwd();
const standaloneDir = path.join(rootDir, '.next', 'standalone');
const standaloneNextDir = path.join(standaloneDir, '.next');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyRecursive(src, dest) {
    if (!fs.existsSync(src)) return;

    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
        ensureDir(dest);
        fs.readdirSync(src).forEach(child => {
            copyRecursive(path.join(src, child), path.join(dest, child));
        });
    } else {
        fs.copyFileSync(src, dest);
        // Ensure copied files are writable (system files like npm may be read-only,
        // which causes codesign to fail with "Permission denied")
        try {
            const destStats = fs.statSync(dest);
            if (!(destStats.mode & 0o200)) {
                fs.chmodSync(dest, destStats.mode | 0o644);
            }
        } catch {}
    }
}

function removePath(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
}

function ensureExecutable(filePath) {
    if (!fs.existsSync(filePath) || process.platform === "win32") return;
    fs.chmodSync(filePath, 0o755);
}


/**
 * Node.js version bundled with the Electron app for MCP subprocess spawning.
 *
 * Pinned deliberately — NOT derived from `process.versions.node` — so the runtime
 * shipped to users is independent of whatever Node the build machine happens to run.
 * This guarantees deterministic, reproducible builds across contributors.
 *
 * Override at build time (rarely needed):
 *   BUNDLED_NODE_VERSION=24.14.1 npm run electron:prepare
 *
 * When bumping: update this constant, run a full bundle locally to verify
 * `otool -L` still reports zero non-system dylib dependencies, and note the
 * change in the release notes.
 */
const BUNDLED_NODE_VERSION = '24.14.1';

/**
 * Resolve the exact Node.js version to bundle.
 *
 * @returns {string} e.g. "24.14.1"
 */
function resolveBundledNodeVersion() {
    const explicit = process.env.BUNDLED_NODE_VERSION;
    if (explicit) {
        const cleaned = explicit.replace(/^v/, '').trim();
        // Accept full SemVer 2.0.0 — the prerelease/build-metadata grammar
        // matters because Node ships ad-hoc tags like `24.0.0-nightly20240501`
        // and `24.14.1+rc1` for early-adopter testing, and rejecting those
        // would have forced anyone on a nightly to manually patch this script.
        // Grammar: MAJOR.MINOR.PATCH(-PRERELEASE)?(+BUILD)?
        //   PRERELEASE = dot-sep identifiers of [0-9A-Za-z-]
        //   BUILD      = dot-sep identifiers of [0-9A-Za-z-]
        const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
        if (!SEMVER_RE.test(cleaned)) {
            console.warn(`  Warning: BUNDLED_NODE_VERSION="${explicit}" is not a valid semver; using pinned ${BUNDLED_NODE_VERSION}`);
            return BUNDLED_NODE_VERSION;
        }
        console.log(`  Using BUNDLED_NODE_VERSION=${cleaned} (env override of pinned ${BUNDLED_NODE_VERSION})`);
        return cleaned;
    }
    return BUNDLED_NODE_VERSION;
}

/**
 * Download the official Node.js binary from nodejs.org.
 *
 * Official binaries are fully statically linked (openssl, icu, libuv, etc.)
 * and have zero external dylib dependencies beyond macOS system libraries.
 * This is critical because Homebrew/nvm Node binaries dynamically link against
 * ~10 Homebrew dylibs that do NOT exist on end users' machines.
 *
 * @param {string} nodeVersion - e.g. "24.15.0"
 * @param {string} destPath - absolute path where the binary should be written
 * @returns {boolean} true if download succeeded
 */
function downloadOfficialNodeBinary(nodeVersion, destPath) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platform = process.platform === 'darwin' ? 'darwin' : 'win';

    if (process.platform === 'win32') {
        // Windows: download .exe directly
        const url = `https://nodejs.org/dist/v${nodeVersion}/win-${arch}/node.exe`;
        console.log(`  Downloading official Node.js v${nodeVersion} for Windows ${arch}...`);
        console.log(`  URL: ${url}`);
        try {
            execSync(`curl -fsSL "${url}" -o "${destPath}"`, { stdio: 'inherit', timeout: 120000 });
            return true;
        } catch (error) {
            console.error(`  Failed to download Node.js: ${error.message}`);
            return false;
        }
    }

    // macOS: download tarball and extract the binary
    const tarballName = `node-v${nodeVersion}-${platform}-${arch}`;
    const url = `https://nodejs.org/dist/v${nodeVersion}/${tarballName}.tar.gz`;
    const tempDir = path.join(require('os').tmpdir(), `node-download-${Date.now()}`);

    console.log(`  Downloading official Node.js v${nodeVersion} for macOS ${arch}...`);
    console.log(`  URL: ${url}`);

    try {
        fs.mkdirSync(tempDir, { recursive: true });
        // Download and extract only the bin/node file
        execSync(
            `curl -fsSL "${url}" | tar -xz -C "${tempDir}" "${tarballName}/bin/node"`,
            { stdio: 'inherit', timeout: 120000 }
        );

        const extractedBinary = path.join(tempDir, tarballName, 'bin', 'node');
        if (!fs.existsSync(extractedBinary)) {
            console.error(`  Error: Extracted binary not found at ${extractedBinary}`);
            return false;
        }

        fs.copyFileSync(extractedBinary, destPath);
        // Clean up temp dir
        fs.rmSync(tempDir, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error(`  Failed to download Node.js: ${error.message}`);
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        return false;
    }
}

function pruneOnnxRuntime(baseDir, napiDirName, keepOs, keepArch) {
    const napiDir = path.join(baseDir, "bin", napiDirName);
    if (!fs.existsSync(napiDir)) return;

    for (const entry of fs.readdirSync(napiDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name !== keepOs) {
            removePath(path.join(napiDir, entry.name));
            continue;
        }

        const archDir = path.join(napiDir, entry.name);
        for (const archEntry of fs.readdirSync(archDir, { withFileTypes: true })) {
            if (!archEntry.isDirectory()) continue;
            if (archEntry.name !== keepArch) {
                removePath(path.join(archDir, archEntry.name));
            }
        }
    }
}

function pruneEsbuildBinaries(esbuildRoot, keepOs, keepArch) {
    if (!fs.existsSync(esbuildRoot)) return;

    for (const entry of fs.readdirSync(esbuildRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        const isPlatformDir = /^(aix|android|darwin|freebsd|linux|netbsd|openbsd|sunos|win32)/.test(name);
        if (!isPlatformDir) continue;

        const expected = `${keepOs}-${keepArch}`;
        if (name !== expected) {
            removePath(path.join(esbuildRoot, name));
        }
    }
}

function pruneStandaloneForPlatform(standaloneRoot) {
    const platform = process.platform;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const keepOs = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;

    if (!keepOs) return;

    removePath(path.join(standaloneRoot, "node_modules", ".cache"));

    const ortPaths = [
        path.join(standaloneRoot, "node_modules", "onnxruntime-node"),
        path.join(standaloneRoot, "node_modules", "@huggingface", "transformers", "node_modules", "onnxruntime-node"),
    ];
    for (const ortPath of ortPaths) {
        pruneOnnxRuntime(ortPath, "napi-v6", keepOs, arch);
        pruneOnnxRuntime(ortPath, "napi-v3", keepOs, arch);
    }
    pruneEsbuildBinaries(path.join(standaloneRoot, "node_modules", "@esbuild"), keepOs, arch);
}

console.log('--- Electron Prepare ---');

// 0. Remove build artifacts and sensitive files that Next.js standalone copies from project root
// These would otherwise bloat the final package (dist-electron alone is 600MB+)
// Keep heavy resources (models/comfyui/binaries) out of standalone; they are copied via
// dedicated electron-builder extraResources rules with platform-aware filtering.
const standaloneJunk = [
    'dist-electron',
    '.git',
    '.env.local',
    '.env.example',
    '.local-data',
    'models',
    'binaries',
    // Source code directories - Next.js standalone copies the project root,
    // but we only need the compiled server.js and .next/ output, not source code
    'app',
    'components',
    'hooks',
    'i18n',
    'selene-source',
];
for (const name of standaloneJunk) {
    const target = path.join(standaloneDir, name);
    if (fs.existsSync(target)) {
        console.log(`Removing ${name} from standalone...`);
        removePath(target);
    }
}

// 1. Ensure .next/standalone/.next exists
console.log('Ensuring directory structure...');
ensureDir(standaloneNextDir);

// 2. Copy public folder if it exists
const publicSrc = path.join(rootDir, 'public');
const publicDest = path.join(standaloneDir, 'public');
if (fs.existsSync(publicSrc)) {
    console.log('Copying public folder...');
    copyRecursive(publicSrc, publicDest);
} else {
    console.log('Skipping public folder (not found)');
}

// 3. Copy .next/static
console.log('Copying .next/static...');
const staticSrc = path.join(rootDir, '.next', 'static');
const staticDest = path.join(standaloneNextDir, 'static');
copyRecursive(staticSrc, staticDest);

// 4. Copy lib folder
console.log('Copying lib folder...');
const libSrc = path.join(rootDir, 'lib');
const libDest = path.join(standaloneDir, 'lib');
copyRecursive(libSrc, libDest);

// 4b. Copy Tailwind runtime config used by the design workspace preview compiler.
const tailwindConfigSrc = path.join(rootDir, 'tailwind.preview.config.cjs');
const tailwindConfigDest = path.join(standaloneDir, 'tailwind.preview.config.cjs');
if (fs.existsSync(tailwindConfigSrc)) {
    console.log('Copying tailwind.preview.config.cjs...');
    fs.copyFileSync(tailwindConfigSrc, tailwindConfigDest);
} else {
    console.log('Skipping tailwind.preview.config.cjs (not found)');
}

/**
 * Copy a list of node_modules packages from rootDir into the standalone build.
 * Each entry: { name, src, dest } where src/dest are relative to node_modules.
 */
function copyNodeDependencies(deps) {
    for (const dep of deps) {
        console.log(`Copying ${dep.name} folder...`);
        const depSrc = path.join(rootDir, 'node_modules', dep.src);
        const depDest = path.join(standaloneDir, 'node_modules', dep.dest);
        if (fs.existsSync(depSrc)) {
            ensureDir(path.dirname(depDest));
            if (fs.existsSync(depDest)) {
                fs.rmSync(depDest, { recursive: true, force: true });
            }
            copyRecursive(depSrc, depDest);
        } else {
            console.log(`Skipping ${dep.name} folder (not found)`);
        }
    }
}

// 5. Copy pdf-parse and its dependencies for PDF parsing support
// pdf-parse requires: pdfjs-dist (PDF.js library) and @napi-rs/canvas (native canvas bindings)
copyNodeDependencies([
    { name: 'pdf-parse', src: 'pdf-parse', dest: 'pdf-parse' },
    { name: 'pdfjs-dist', src: 'pdfjs-dist', dest: 'pdfjs-dist' },
    { name: '@napi-rs/canvas', src: '@napi-rs', dest: '@napi-rs' },
]);

// 7. Copy Puppeteer and bundled Chromium for local web scraping
copyNodeDependencies([
    { name: 'puppeteer', src: 'puppeteer', dest: 'puppeteer' },
]);

// 8. Copy npm CLI for bundled npx/npm support in production
// npm is bundled with Node.js, not in project node_modules.
// Look for it in the system Node.js installation first.
const systemNpmPath = (() => {
    try {
        const lookupCmd = process.platform === 'win32' ? 'where npm' : 'which npm';
        const npmBin = require('child_process').execSync(lookupCmd, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
        // Unix: npm binary at <prefix>/bin/npm, package at <prefix>/lib/node_modules/npm
        // Windows: npm.cmd at <prefix>/npm.cmd, package at <prefix>/node_modules/npm
        const prefix = path.resolve(path.dirname(npmBin), '..');
        const candidates = [
            path.join(prefix, 'lib', 'node_modules', 'npm'),
            path.join(prefix, 'node_modules', 'npm'),
            // Windows: where returns <prefix>/npm.cmd directly (no bin/ subdir)
            path.join(path.dirname(npmBin), 'node_modules', 'npm'),
        ];
        const found = candidates.find(p => fs.existsSync(p));
        if (found) return found;
    } catch {}
    return null;
})();

if (systemNpmPath) {
    console.log('Copying npm folder...');
    const npmDest = path.join(standaloneDir, 'node_modules', 'npm');
    ensureDir(path.dirname(npmDest));
    if (fs.existsSync(npmDest)) {
        fs.rmSync(npmDest, { recursive: true, force: true });
    }
    copyRecursive(systemNpmPath, npmDest);
    console.log(`  Bundled npm from ${systemNpmPath}`);
} else {
    // Fallback: try project node_modules
    copyNodeDependencies([
        { name: 'npm', src: 'npm', dest: 'npm' },
    ]);
}

// 9. Copy local embedding dependencies for offline Transformers.js support
copyNodeDependencies([
    { name: '@huggingface/transformers', src: '@huggingface/transformers', dest: '@huggingface/transformers' },
    { name: 'onnxruntime-node', src: 'onnxruntime-node', dest: 'onnxruntime-node' },
]);

// 9b. Copy design preview compiler dependencies that Next standalone may trim.
// These packages are resolved dynamically by esbuild when users generate React/Tailwind
// components in the design workspace, so they must exist in the packaged app even if
// Turbopack didn't trace them into standalone output.
const designPreviewDependencies = [
    { name: 'react', src: 'react', dest: 'react' },
    { name: 'react-dom', src: 'react-dom', dest: 'react-dom' },
    { name: 'scheduler', src: 'scheduler', dest: 'scheduler' },
    { name: 'tailwindcss-animate', src: 'tailwindcss-animate', dest: 'tailwindcss-animate' },
    { name: 'lucide-react', src: 'lucide-react', dest: 'lucide-react' },
    { name: 'framer-motion', src: 'framer-motion', dest: 'framer-motion' },
];

for (const dep of designPreviewDependencies) {
    console.log(`Copying ${dep.name} folder...`);
    const depSrc = path.join(rootDir, 'node_modules', dep.src);
    const depDest = path.join(standaloneDir, 'node_modules', dep.dest);
    if (fs.existsSync(depSrc)) {
        ensureDir(path.dirname(depDest));
        if (fs.existsSync(depDest)) {
            fs.rmSync(depDest, { recursive: true, force: true });
        }
        copyRecursive(depSrc, depDest);
    } else {
        console.log(`Skipping ${dep.name} folder (not found)`);
    }
}

// 10. Copy rebuilt native modules from root node_modules to standalone
// This is critical because Next.js standalone doesn't include build files (binding.gyp, src/, deps/)
// needed by electron-rebuild. We rebuild in root node_modules first, then copy the binaries here.
console.log('Copying rebuilt native module binaries...');

const nativeModuleBinaries = [
    {
        name: 'better-sqlite3',
        src: 'better-sqlite3/build/Release/better_sqlite3.node',
        dest: 'better-sqlite3/build/Release/better_sqlite3.node'
    },
];

// 10a. Copy sharp's native DLLs that Next.js file tracing misses
// The .node addon is traced, but libvips DLLs are loaded dynamically at runtime
// and won't be picked up by static analysis.
console.log('Copying sharp native DLLs...');
const sharpPlatformDir = `sharp-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const sharpLibSrc = path.join(rootDir, 'node_modules', '@img', sharpPlatformDir, 'lib');
const sharpLibDest = path.join(standaloneDir, 'node_modules', '@img', sharpPlatformDir, 'lib');
if (fs.existsSync(sharpLibSrc)) {
    ensureDir(sharpLibDest);
    for (const file of fs.readdirSync(sharpLibSrc)) {
        const src = path.join(sharpLibSrc, file);
        const dest = path.join(sharpLibDest, file);
        if (!fs.existsSync(dest)) {
            fs.copyFileSync(src, dest);
            console.log(`  Copied ${file}`);
        }
    }
} else {
    console.log(`  Sharp platform package not found at ${sharpLibSrc} — skipping`);
}

for (const mod of nativeModuleBinaries) {
    const srcPath = path.join(rootDir, 'node_modules', mod.src);
    const destPath = path.join(standaloneDir, 'node_modules', mod.dest);

    if (fs.existsSync(srcPath)) {
        console.log(`Copying ${mod.name} native binary...`);
        ensureDir(path.dirname(destPath));
        fs.copyFileSync(srcPath, destPath);
        const srcStats = fs.statSync(srcPath);
        const destStats = fs.statSync(destPath);
        console.log(`  Source: ${srcStats.size} bytes`);
        console.log(`  Destination: ${destStats.size} bytes`);
    } else {
        console.warn(`Warning: ${mod.name} native binary not found at ${srcPath}`);
    }
}

// 10b. Remove dev/build-time-only packages from standalone node_modules
// These get pulled in by Next.js standalone tracing or transitive deps but aren't needed at runtime.
// electron: duplicates the Electron framework already in Contents/Frameworks/ (~270 MB)
// typescript: now needed at runtime by design workspace validation (lib/design/workspace/validation.ts)
console.log('Removing dev-only packages from standalone...');
const devOnlyPackages = ['electron', 'webpack', 'terser-webpack-plugin'];
for (const pkg of devOnlyPackages) {
    const pkgPath = path.join(standaloneDir, 'node_modules', pkg);
    if (fs.existsSync(pkgPath)) {
        console.log(`  Removing ${pkg} (dev/build-only, not needed at runtime)...`);
        removePath(pkgPath);
    }
}

// 10c. Clean up broken symlinks in Turbopack external module wrappers (.next/node_modules)
// Turbopack creates symlinks like webpack-<hash> → ../../node_modules/webpack for
// serverExternalPackages. After step 10b removes dev packages (webpack, etc.), these
// symlinks become dangling. Broken symlinks cause codesign to fail with ENOENT during
// Electron packaging on macOS.
console.log('Cleaning up broken symlinks in standalone .next/node_modules...');
const turbopackNodeModules = path.join(standaloneDir, '.next', 'node_modules');
if (fs.existsSync(turbopackNodeModules)) {
    for (const entry of fs.readdirSync(turbopackNodeModules)) {
        const entryPath = path.join(turbopackNodeModules, entry);
        try {
            const stats = fs.lstatSync(entryPath);
            if (stats.isSymbolicLink()) {
                // Check if symlink target exists
                try {
                    fs.statSync(entryPath); // follows symlink
                } catch {
                    console.log(`  Removing broken symlink: ${entry}`);
                    fs.unlinkSync(entryPath);
                }
            }
        } catch {}
    }
}

// 11. Prune platform-specific binaries and caches from standalone
console.log('Pruning standalone dependencies for current platform...');
pruneStandaloneForPlatform(standaloneDir);

// 12. Bundle apply_patch shim so Codex-style patches work in packaged builds.
console.log('Bundling apply_patch compatibility shim...');
const bundledToolsSrcDir = path.join(rootDir, 'scripts', 'bundled-tools');
const bundledToolsDestDir = path.join(standaloneDir, 'tools', 'bin');
const applyPatchLauncherSrc = path.join(bundledToolsSrcDir, 'apply_patch');
const applyPatchRuntimeSrc = path.join(bundledToolsSrcDir, 'apply_patch.js');
const applyPatchLauncherDest = path.join(bundledToolsDestDir, 'apply_patch');
const applyPatchRuntimeDest = path.join(bundledToolsDestDir, 'apply_patch.js');

const applyPatchCmdSrc = path.join(bundledToolsSrcDir, 'apply_patch.cmd');
const applyPatchCmdDest = path.join(bundledToolsDestDir, 'apply_patch.cmd');

if (fs.existsSync(applyPatchLauncherSrc) && fs.existsSync(applyPatchRuntimeSrc)) {
    ensureDir(bundledToolsDestDir);
    fs.copyFileSync(applyPatchLauncherSrc, applyPatchLauncherDest);
    fs.copyFileSync(applyPatchRuntimeSrc, applyPatchRuntimeDest);
    if (fs.existsSync(applyPatchCmdSrc)) {
        fs.copyFileSync(applyPatchCmdSrc, applyPatchCmdDest);
    }
    ensureExecutable(applyPatchLauncherDest);
    ensureExecutable(applyPatchRuntimeDest);
    console.log('  Bundled apply_patch shim into standalone/tools/bin');
} else {
    console.warn('  Warning: apply_patch shim sources missing, skipping apply_patch bundling');
}

// 12b. Ensure the bundled ripgrep binary remains executable in packaged builds.
console.log('Ensuring bundled ripgrep binary is executable...');
const ripgrepBinDir = path.join(standaloneDir, 'node_modules', '@vscode', 'ripgrep', 'bin');
const ripgrepBinary = path.join(ripgrepBinDir, process.platform === 'win32' ? 'rg.exe' : 'rg');
if (fs.existsSync(ripgrepBinary)) {
    ensureExecutable(ripgrepBinary);
    console.log(`  Bundled ripgrep binary ready at ${ripgrepBinary}`);
} else {
    console.warn(`  Warning: bundled ripgrep binary missing at ${ripgrepBinary}`);
}

// 13. Bundle ffmpeg static binary for audio conversion (whisper.cpp preprocessing)
console.log('Bundling ffmpeg static binary...');
try {
    // require('ffmpeg-static') executes the module and returns the path to the
    // real platform-specific binary.  require.resolve() would return the JS
    // module path instead, which is a tiny JS wrapper — not the actual binary.
    const ffmpegBinaryPath = require('ffmpeg-static');
    if (ffmpegBinaryPath && fs.existsSync(ffmpegBinaryPath)) {
        const ffmpegBinaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

        // Copy into node_modules/.bin for backward compat
        const ffmpegBinDir = path.join(standaloneDir, 'node_modules', '.bin');
        ensureDir(ffmpegBinDir);
        const ffmpegBinDest = path.join(ffmpegBinDir, ffmpegBinaryName);
        fs.copyFileSync(ffmpegBinaryPath, ffmpegBinDest);
        ensureExecutable(ffmpegBinDest);

        const stats = fs.statSync(ffmpegBinDest);
        console.log(`  Bundled ffmpeg: ${(stats.size / 1024 / 1024).toFixed(1)} MB → .bin/`);
    } else {
        console.warn('  Warning: ffmpeg-static binary not found at resolved path:', ffmpegBinaryPath);
    }
} catch (e) {
    console.warn('  Warning: ffmpeg-static package not installed, skipping ffmpeg bundling:', e.message);
}

// 13. Bundle whisper-cli and its dylibs for local speech-to-text
console.log('Bundling whisper-cli for local STT...');
const whisperBundleDir = path.join(rootDir, 'binaries', 'whisper');
if (fs.existsSync(whisperBundleDir)) {
    const whisperDestDir = path.join(standaloneDir, 'binaries', 'whisper');
    ensureDir(whisperDestDir);
    copyRecursive(whisperBundleDir, whisperDestDir);
    // Ensure binaries are executable
    const whisperBinCandidates = [
        path.join(whisperDestDir, 'bin', 'whisper-whisper-cli'),
        path.join(whisperDestDir, 'bin', 'whisper-whisper-cli.exe'),
        path.join(whisperDestDir, 'bin', 'whisper-cli'),
        path.join(whisperDestDir, 'bin', 'whisper-cli.exe'),
        path.join(whisperDestDir, 'bin', 'main.exe'),
    ];
    const whisperBin = whisperBinCandidates.find((p) => fs.existsSync(p));
    if (whisperBin) {
        ensureExecutable(whisperBin);
        console.log(`  Bundled whisper-cli binary`);
    }
    // Calculate total size
    let totalSize = 0;
    const walkDir = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) walkDir(fullPath);
            else totalSize += fs.statSync(fullPath).size;
        }
    };
    walkDir(whisperDestDir);
    console.log(`  Total whisper bundle: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
} else {
    console.log('  Whisper bundle not found at binaries/whisper — run: node scripts/bundle-whisper.js');
    console.log('  Users will need to install whisper.cpp separately (macOS: brew install whisper-cpp, Windows: download whisper-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases)');
}

// 14. Bundle RTK binary for experimental command optimization.
console.log('Bundling RTK binary...');
try {
    execSync('node scripts/bundle-rtk.js', { stdio: 'inherit' });
} catch (error) {
    console.log('  RTK bundle step failed or skipped; experimental RTK mode will remain unavailable.');
}

// 15. Bundle Node.js executable for MCP subprocess spawning
// Downloads the official Node.js binary from nodejs.org which is fully statically linked.
// IMPORTANT: Do NOT use process.execPath (Homebrew/nvm node) — those binaries dynamically
// link against ~10 Homebrew dylibs (libuv, openssl, icu, brotli, etc.) that don't exist
// on end users' machines, causing the bundled node to crash with "Library not loaded".
if (process.platform === 'win32' || process.platform === 'darwin') {
    const platformName = process.platform === 'win32' ? 'Windows' : 'macOS';
    console.log(`Bundling official Node.js binary for ${platformName}...`);

    // Use the version pinned in this script — NOT the build machine's Node version.
    // process.versions.node reflects the local dev install (nvm/brew/etc.) which
    // may lag behind the version we want to ship. See resolveBundledNodeVersion().
    const nodeVersion = resolveBundledNodeVersion(); // e.g. "24.14.1"
    const nodeBinDir = path.join(standaloneDir, 'node_modules', '.bin');
    const nodeExeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const nodeExeDest = path.join(nodeBinDir, nodeExeName);

    ensureDir(nodeBinDir);

    const downloaded = downloadOfficialNodeBinary(nodeVersion, nodeExeDest);
    if (downloaded) {
        ensureExecutable(nodeExeDest);
        const stats = fs.statSync(nodeExeDest);
        console.log(`  Bundled official ${nodeExeName} v${nodeVersion}: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);

        // Verify the binary has no external dylib dependencies (sanity check on macOS)
        if (process.platform === 'darwin') {
            try {
                const otoolOutput = execSync(`otool -L "${nodeExeDest}"`, { encoding: 'utf-8' });
                const nonSystemDeps = otoolOutput.split('\n')
                    .filter(line => line.includes('.dylib'))
                    .filter(line => !line.includes('/usr/lib/') && !line.includes('/System/'))
                    .map(line => line.trim());
                if (nonSystemDeps.length > 0) {
                    console.warn('  WARNING: Official node binary has non-system dylib dependencies:');
                    nonSystemDeps.forEach(dep => console.warn(`    ${dep}`));
                    console.warn('  This may cause issues on end user machines!');
                } else {
                    console.log('  Verified: No external dylib dependencies (fully static)');
                }
            } catch {
                console.warn('  Warning: Could not verify dylib dependencies (otool not available)');
            }
        }
    } else {
        // Fallback: copy local node binary (may have dylib dependencies)
        console.warn('  WARNING: Failed to download official Node.js binary.');
        console.warn('  Falling back to local node binary — this may not work on end user machines!');
        const nodeExeSrc = process.execPath;
        if (fs.existsSync(nodeExeSrc)) {
            fs.copyFileSync(nodeExeSrc, nodeExeDest);
            ensureExecutable(nodeExeDest);
            const stats = fs.statSync(nodeExeDest);
            console.log(`  Bundled local ${nodeExeName} (fallback): ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
        } else {
            console.error('  Error: Could not find any Node.js executable to bundle');
        }
    }
}

console.log('--- Preparation Complete ---');
