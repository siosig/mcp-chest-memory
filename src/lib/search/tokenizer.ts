// Japanese morphological tokenizer using Sudachi-WASM.
// Returns space-separated surface forms for use in the content_tokenized column.
// Fails open: if Sudachi is unavailable, returns the original text (whitespace-split).

import { dictCacheDir } from "../../utils/env.js";
import { logger } from "../../utils/logger.js";

type SudachiTokenizeMode = "A" | "B" | "C";

interface SudachiModule {
  tokenize(text: string, mode?: SudachiTokenizeMode): string[];
}

let sudachiPromise: Promise<SudachiModule | null> | undefined;

function getSudachi(): Promise<SudachiModule | null> {
  if (!sudachiPromise) {
    sudachiPromise = (async (): Promise<SudachiModule | null> => {
      try {
        // sudachi-wasm package; pure ESM with WASM bundled.
        const mod = await import("sudachi");
        // The module may expose tokenize directly or via a TokenizeMode setup.
        // We wrap into a unified interface.
        if (typeof (mod as unknown as { tokenize: unknown }).tokenize === "function") {
          return mod as unknown as SudachiModule;
        }
        // Some versions require initialization; attempt default export call.
        if (typeof mod.default === "function") {
          const instance = await (mod.default as unknown as () => Promise<SudachiModule>)();
          return instance;
        }
        logger.warn({ dictDir: dictCacheDir() }, "sudachi module loaded but API not recognized; falling back to whitespace split");
        return null;
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "sudachi unavailable; FTS tokenization falls back to whitespace split",
        );
        return null;
      }
    })();
  }
  return sudachiPromise;
}

/**
 * Tokenize text into space-separated surface forms.
 * Uses Sudachi morphological analysis when available.
 * Falls back to whitespace splitting on any failure.
 */
export async function tokenize(text: string): Promise<string> {
  if (!text || !text.trim()) return text;
  const sudachi = await getSudachi();
  if (!sudachi) {
    return text.replace(/\s+/g, " ").trim();
  }
  try {
    const tokens = sudachi.tokenize(text, "C");
    if (Array.isArray(tokens) && tokens.length > 0) {
      return tokens.join(" ");
    }
    return text.replace(/\s+/g, " ").trim();
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "sudachi tokenize() failed; falling back to whitespace split",
    );
    return text.replace(/\s+/g, " ").trim();
  }
}

/** Reset the cached Sudachi instance (for testing only). */
export function resetTokenizerForTest(): void {
  sudachiPromise = undefined;
}
