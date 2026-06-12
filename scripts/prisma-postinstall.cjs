#!/usr/bin/env node
'use strict';
// Postinstall: sets up node_modules/.prisma/client/ without the prisma CLI.
//
// Why this exists:
//   @prisma/client's postinstall creates throw-stub files in .prisma/client/
//   and then runs `prisma generate` to replace them with the real client code.
//   When mcp-chest-memory is installed via `npx -y -p mcp-chest-memory`, the
//   prisma CLI is NOT installed (it's in devDependencies), so the stubs remain
//   and any import of PrismaClient throws "@prisma/client did not initialize."
//
// What we do instead:
//   1. Copy our pre-generated JS/d.ts/schema files (built into dist/) over the
//      stubs — identical to what `prisma generate` would produce.
//   2. Copy the platform-specific query engine binary from @prisma/engines,
//      which is a transitive dep of @prisma/client and always present with the
//      correct binary for the current platform (its own postinstall handles it).
//
// Idempotent: skips when .prisma/client/default.js is already real (not a stub).

const fs = require('node:fs');
const path = require('node:path');

// Pre-generated client files bundled with this package.
// __dirname = node_modules/mcp-chest-memory/scripts/
const GEN_SRC = path.join(__dirname, '..', 'dist', 'lib', 'db', 'prisma-generated');

if (!fs.existsSync(GEN_SRC) || !fs.existsSync(path.join(GEN_SRC, 'index.js'))) {
  // Developer install from source (no dist/ yet). Nothing to do.
  process.exit(0);
}

// @prisma/client resolves require('.prisma/client/default') via node_modules
// walk: starts at @prisma/client's own parent node_modules folder and walks up.
// From node_modules/mcp-chest-memory/, one level up is node_modules/.
const TARGET = path.join(__dirname, '..', '..', '.prisma', 'client');

// Already properly set up? Check if default.js is still the throw stub.
function isThrowStub(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').includes('did not initialize');
  } catch {
    return true; // Missing file = treat as stub
  }
}
if (!isThrowStub(path.join(TARGET, 'default.js'))) {
  process.exit(0); // Already initialised by prisma generate or a prior run
}

// Step 1: Copy pre-generated JS/d.ts/schema/package.json files over the stubs.
try {
  fs.mkdirSync(TARGET, { recursive: true });
} catch {
  process.exit(0);
}
let copied = 0;
for (const file of fs.readdirSync(GEN_SRC)) {
  try {
    fs.copyFileSync(path.join(GEN_SRC, file), path.join(TARGET, file));
    copied++;
  } catch {}
}

// Step 2: Copy platform-specific query engine binary from @prisma/engines.
// The binary is not in our package (it's platform-specific and large); instead
// @prisma/engines (a transitive dep of @prisma/client) ships the correct one
// for the current machine. We just need to find and copy it.
function findEnginesDir() {
  try {
    const clientPkg = require.resolve('@prisma/client/package.json');
    // Traverse: package.json → @prisma/client/ → @prisma/ → node_modules/
    // @prisma/engines lives as a sibling of @prisma/client in that node_modules/
    const nodeModulesDir = path.dirname(path.dirname(path.dirname(clientPkg)));
    const candidates = [
      path.join(nodeModulesDir, '@prisma', 'engines'),         // pnpm store / npm
      path.join(path.dirname(nodeModulesDir), '@prisma', 'engines'), // hoisted fallback
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'package.json'))) return c;
    }
  } catch {}
  // Fallback: direct resolution (works for npm flat node_modules)
  try {
    return path.dirname(require.resolve('@prisma/engines/package.json'));
  } catch {}
  return null;
}

let engineCopied = false;
const engDir = findEnginesDir();
if (engDir) {
  const engine = fs.readdirSync(engDir).find(f => /^libquery_engine.*\.node$/.test(f));
  if (engine) {
    try {
      fs.copyFileSync(path.join(engDir, engine), path.join(TARGET, engine));
      engineCopied = true;
    } catch {}
  }
}

if (copied > 0) {
  const note = engineCopied ? '' : ' (engine not copied — may fall back to @prisma/engines location)';
  process.stdout.write(`[mcp-chest-memory] Prisma client initialized${note}\n`);
}
