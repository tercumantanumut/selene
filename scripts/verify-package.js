#!/usr/bin/env node

/**
 * Packaging verification script for Electron builds.
 * 
 * Ensures that:
 * 1. Source code is NOT bundled into production app
 * 2. Required runtime files ARE present
 * 3. App bundle structure is correct
 * 
 * Run after: npm run electron:build (or with --dir flag)
 * Usage: node scripts/verify-package.js [--platform mac|win]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const platformArg = args.find(arg => arg.startsWith('--platform='));
const platform = platformArg ? platformArg.split('=')[1] : process.platform;

// Determine app path based on platform
const distDir = path.join(process.cwd(), 'dist-electron');
let appResourcesPath;

if (platform === 'darwin' || platform === 'mac') {
  // macOS: Selene.app/Contents/Resources
  const macDir = path.join(distDir, 'mac');
  const appPath = path.join(macDir, 'Selene.app', 'Contents', 'Resources');
  if (fs.existsSync(appPath)) {
    appResourcesPath = appPath;
  } else {
    // Try mac-arm64 or mac-x64
    const macArm = path.join(distDir, 'mac-arm64', 'Selene.app', 'Contents', 'Resources');
    const macX64 = path.join(distDir, 'mac-x64', 'Selene.app', 'Contents', 'Resources');
    if (fs.existsSync(macArm)) appResourcesPath = macArm;
    else if (fs.existsSync(macX64)) appResourcesPath = macX64;
  }
} else if (platform === 'win32' || platform === 'win') {
  // Windows: win-unpacked/resources
  const winDir = path.join(distDir, 'win-unpacked', 'resources');
  if (fs.existsSync(winDir)) {
    appResourcesPath = winDir;
  }
}

if (!appResourcesPath || !fs.existsSync(appResourcesPath)) {
  console.error('❌ Could not find packaged app in dist-electron/');
  console.error('   Run this script after: npm run electron:build');
  console.error('   Or build with --dir flag: npm run electron:build -- --dir');
  process.exit(1);
}

console.log('📦 Verifying Electron package...');
console.log(`   App resources: ${appResourcesPath}\n`);

let hasErrors = false;
let hasWarnings = false;

// --- Check 1: Source code should NOT be bundled ---
console.log('1️⃣  Checking for bundled source code...');

const forbiddenPaths = [
  'standalone/selene-source',
  'standalone/app',
  'standalone/components',
  'standalone/hooks',
  'standalone/i18n',
];

for (const forbidden of forbiddenPaths) {
  const fullPath = path.join(appResourcesPath, forbidden);
  if (fs.existsSync(fullPath)) {
    console.error(`   ❌ FAIL: Found bundled source at ${forbidden}`);
    hasErrors = true;
  }
}

if (!hasErrors) {
  console.log('   ✅ PASS: No source code found in bundle\n');
} else {
  console.log('');
}

// --- Check 2: Required runtime files SHOULD exist ---
console.log('2️⃣  Checking for required runtime files...');

const requiredPaths = [
  'standalone/server.js',
  'standalone/.next/static',
  'standalone/node_modules',
  'standalone/lib',
  'standalone/tools/bin/apply_patch.js',
  (platform === 'win32' || platform === 'win')
    ? 'standalone/tools/bin/apply_patch.cmd'
    : 'standalone/tools/bin/apply_patch',
  // Bundled Node runtime + npm/npx CLI files are required for execute-command in packaged apps.
  (platform === 'win32' || platform === 'win')
    ? 'standalone/node_modules/.bin/node.exe'
    : 'standalone/node_modules/.bin/node',
  'standalone/node_modules/npm/bin/npm-cli.js',
  'standalone/node_modules/npm/bin/npx-cli.js',
  'standalone/node_modules/@vscode/ripgrep/lib/index.js',
  (platform === 'win32' || platform === 'win')
    ? 'standalone/node_modules/@vscode/ripgrep/bin/rg.exe'
    : 'standalone/node_modules/@vscode/ripgrep/bin/rg',
  'standalone/node_modules/@askalf/dario/dist/cli.js',
];

// RTK bundle is optional at runtime (experimental), but warn if absent in package.
const optionalPaths = [
  `binaries/rtk/${
    process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'macos-arm64/rtk' : 'macos-x64/rtk')
      : process.platform === 'win32'
        ? (process.arch === 'arm64' ? 'windows-arm64/rtk.exe' : 'windows-x64/rtk.exe')
        : (process.arch === 'arm64' ? 'linux-arm64/rtk' : 'linux-x64/rtk')
  }`,
];

for (const required of requiredPaths) {
  const fullPath = path.join(appResourcesPath, required);
  if (!fs.existsSync(fullPath)) {
    console.error(`   ❌ FAIL: Missing required file/folder: ${required}`);
    hasErrors = true;
  }
}

// Verify the bundled node binary has no external dylib dependencies (macOS only)
if (platform === 'darwin' || platform === 'mac') {
  const bundledNode = path.join(appResourcesPath, 'standalone', 'node_modules', '.bin', 'node');
  if (fs.existsSync(bundledNode)) {
    try {
      const { execSync } = require('child_process');
      const otoolOutput = execSync(`otool -L "${bundledNode}"`, { encoding: 'utf-8' });
      const nonSystemDeps = otoolOutput.split('\n')
        .filter(line => line.includes('.dylib'))
        .filter(line => !line.includes('/usr/lib/') && !line.includes('/System/'))
        .map(line => line.trim());
      if (nonSystemDeps.length > 0) {
        console.error('   ❌ FAIL: Bundled node binary has non-system dylib dependencies:');
        nonSystemDeps.forEach(dep => console.error(`      ${dep}`));
        console.error('   This means the binary was NOT downloaded from nodejs.org (official).');
        console.error('   Homebrew/nvm binaries will crash on end user machines.');
        hasErrors = true;
      } else {
        console.log('   ✅ Bundled node: no external dylib dependencies (official static binary)');
      }
    } catch {
      console.warn('   ⚠️  WARNING: Could not verify bundled node dylib dependencies');
      hasWarnings = true;
    }
  }
}

if (!hasErrors) {
  console.log('   ✅ PASS: All required runtime files present\n');
} else {
  console.log('');
}

for (const optionalPath of optionalPaths) {
  const fullPath = path.join(appResourcesPath, optionalPath);
  if (!fs.existsSync(fullPath)) {
    console.warn(`   ⚠️  WARNING: Optional RTK binary missing: ${optionalPath}`);
    hasWarnings = true;
  }
}

// --- Check 3: Verify standalone/lib doesn't contain dev artifacts ---
console.log('3️⃣  Checking standalone/lib for dev artifacts...');

const libPath = path.join(appResourcesPath, 'standalone', 'lib');
if (fs.existsSync(libPath)) {
  const libContents = fs.readdirSync(libPath);
  
  // These are runtime libs that SHOULD be there
  const expectedLibDirs = [
    'agent-memory',
    'characters',
    'vectordb',
    'workspace',
    'db',
    'tools',
  ];
  
  // These would indicate source code leakage
  const suspiciousDirs = [
    'test',
    '__tests__',
    'fixtures',
  ];
  
  for (const suspicious of suspiciousDirs) {
    if (libContents.includes(suspicious)) {
      console.warn(`   ⚠️  WARNING: Found ${suspicious}/ in standalone/lib`);
      hasWarnings = true;
    }
  }
  
  if (!hasWarnings) {
    console.log('   ✅ PASS: No dev artifacts in standalone/lib\n');
  } else {
    console.log('');
  }
}

// --- Summary ---
console.log('─'.repeat(50));
if (hasErrors) {
  console.error('❌ Package verification FAILED');
  console.error('   Fix the issues above before releasing.\n');
  process.exit(1);
} else if (hasWarnings) {
  console.warn('⚠️  Package verification completed with warnings');
  console.warn('   Review warnings above.\n');
  process.exit(0);
} else {
  console.log('✅ Package verification PASSED');
  console.log('   App is ready for distribution.\n');
  process.exit(0);
}
