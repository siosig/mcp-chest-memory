#!/usr/bin/env node
'use strict';
// Build-time script: copies the generated Prisma client files from wherever
// `prisma generate` wrote them (varies by package manager) into the stable
// dist/lib/db/prisma-generated/ directory, which is included in the npm
// package so the postinstall script can set up .prisma/client/ without the
// prisma CLI.
//
// Excludes:
//   - Platform-specific engine binary (*.node) — copied at install time from
//     @prisma/engines by scripts/prisma-postinstall.js
//   - Edge/WASM runtime files — not used in Node.js
//   - NFS temp files (.nfs*)
//   - WASM engine (query_engine_bg.wasm, 2 MB) — not used in Node.js

const fs = require('node:fs');
const path = require('node:path');

// Locate the generated directory. With pnpm it's inside the pnpm-store
// alongside @prisma/client; with npm it's at the project-root node_modules.
function findGeneratedDir() {
  try {
    const clientPkg = require.resolve('@prisma/client/package.json');
    // The .prisma/client/ directory lives one level above @prisma/client
    // (i.e. as a sibling in the same node_modules folder).
    // .prisma/client/ is a sibling of the @prisma/ scope dir inside the same
    // node_modules folder. Traverse: package.json → @prisma/client/ → @prisma/ → node_modules/
    const nodeModulesDir = path.dirname(path.dirname(path.dirname(clientPkg)));
    const candidate = path.join(nodeModulesDir, '.prisma', 'client');
    if (fs.existsSync(path.join(candidate, 'index.js'))) return candidate;
  } catch {}
  // Fallback: standard npm flat layout
  const fallback = path.join(__dirname, '..', 'node_modules', '.prisma', 'client');
  if (fs.existsSync(path.join(fallback, 'index.js'))) return fallback;
  return null;
}

const src = findGeneratedDir();
if (!src) {
  console.error('[chest] ERROR: Generated Prisma client not found. Run: pnpm run db:generate');
  process.exit(1);
}

const dest = path.join(__dirname, '..', 'dist', 'lib', 'db', 'prisma-generated');
fs.mkdirSync(dest, { recursive: true });

const SKIP = new Set([
  'wasm.js', 'wasm.d.ts',
  'edge.js', 'edge.d.ts',
  'index-browser.js',
  'query_engine_bg.js',
  'query_engine_bg.wasm',
  'wasm-edge-light-loader.mjs',
  'wasm-worker-loader.mjs',
  'react-native.js', 'react-native.d.ts',
]);
function keep(file) {
  if (file.endsWith('.node')) return false;   // engine binary — platform-specific
  if (file.startsWith('.nfs')) return false;  // NFS lock files
  // path.extname('client.d.ts') === '.ts', not '.d.ts', so check endsWith instead
  return file.endsWith('.js') || file.endsWith('.d.ts') ||
         file.endsWith('.prisma') || file === 'package.json';
}

let copied = 0;
for (const file of fs.readdirSync(src)) {
  if (SKIP.has(file)) continue;
  if (!keep(file)) continue;
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
  copied++;
}
console.log(`[chest] Copied ${copied} Prisma client files → dist/lib/db/prisma-generated/`);
