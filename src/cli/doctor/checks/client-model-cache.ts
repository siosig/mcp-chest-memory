// Client-side embedding model cache check.
//
// FR-024: verify the active embedding model (default `Xenova/bge-m3`) is
// fully present in the local cache so that `chest_remember` / `chest_recall`
// do not trip the historical `extractorPromise` null-cache trap (memory ID
// 5138) on first use.
//
// We look for the canonical `tokenizer.json`, `config.json`, and at least
// one non-empty `.onnx` weight file under the model's cache subtree. We
// recurse a couple of levels because @huggingface/transformers organises
// the cache as `<cacheDir>/<org>/<repo>/<revision>/<file>` and the exact
// layout varies between releases.

import { readdir, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "../types.js";
import { modelCacheDir, validateEnv } from "../../../utils/env.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

const FIX_HINT = "Run: chest-index fetch-model";

interface FoundFiles {
  tokenizer: boolean;
  config: boolean;
  onnx: boolean;
}

async function walk(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  async function inner(dir: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = typeof ent.name === "string" ? ent.name : String(ent.name);
      const full = join(dir, name);
      if (ent.isDirectory()) {
        if (depth < maxDepth) await inner(full, depth + 1);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  await inner(root, 0);
  return out;
}

async function statSafe(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** Detect a tokenizer.json / config.json / *.onnx triplet anywhere below `root`. */
async function scanModelTree(root: string): Promise<FoundFiles> {
  const files = await walk(root, 5);
  const found: FoundFiles = { tokenizer: false, config: false, onnx: false };
  for (const f of files) {
    const base = f.split("/").pop() ?? "";
    if (base === "tokenizer.json") {
      const s = await statSafe(f);
      if (s && s.size > 0) found.tokenizer = true;
    } else if (base === "config.json") {
      const s = await statSafe(f);
      if (s && s.size > 0) found.config = true;
    } else if (base.endsWith(".onnx")) {
      const s = await statSafe(f);
      if (s && s.size > 0) found.onnx = true;
    }
  }
  return found;
}

export async function checkModelCache(): Promise<PartialResult> {
  const env = validateEnv();
  const cacheRoot = modelCacheDir(env);
  const modelId = env.CHEST_EMBED_MODEL;

  // Model id may contain `/` (org/repo). Resolve a `<cacheRoot>/<modelId>`
  // candidate; if missing, also fall back to scanning the entire cache root.
  const modelDir = join(cacheRoot, modelId);
  const rootStat = await statSafe(cacheRoot);
  if (!rootStat) {
    return {
      status: "fail",
      message: `Model cache directory does not exist: ${cacheRoot}`,
      fix_hint: FIX_HINT,
    };
  }
  const modelStat = await statSafe(modelDir);
  const scanRoot = modelStat && modelStat.isDirectory() ? modelDir : cacheRoot;
  const found = await scanModelTree(scanRoot);

  const missing: string[] = [];
  if (!found.tokenizer) missing.push("tokenizer.json");
  if (!found.config) missing.push("config.json");
  if (!found.onnx) missing.push("model weights (*.onnx)");

  if (missing.length > 0) {
    return {
      status: "fail",
      message: `Model cache incomplete at ${scanRoot} — missing: ${missing.join(", ")}`,
      fix_hint: FIX_HINT,
    };
  }
  return {
    status: "ok",
    message: `Model cache complete at ${scanRoot} (model=${modelId})`,
    fix_hint: "",
  };
}
