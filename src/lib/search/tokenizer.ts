// Japanese morphological tokenizer using Sudachi-WASM.
// Returns space-separated surface forms for use in the content_tokenized column.
// Fails open: if Sudachi is unavailable, returns the original text (whitespace-split).

import { logger } from "../../utils/logger.js";

// sudachi@0.1.x: tokenize(input: string, mode: number): string
// TokenizeMode = { A:0, B:1, C:2 } — mode must be a number, not a string.
interface SudachiModule {
  tokenize(text: string, mode: number): string;
  TokenizeMode: { A: number; B: number; C: number };
}

let sudachiPromise: Promise<SudachiModule | null> | undefined;

function getSudachi(): Promise<SudachiModule | null> {
  if (!sudachiPromise) {
    sudachiPromise = (async (): Promise<SudachiModule | null> => {
      try {
        // sudachi-wasm embeds the WASM as base64 and self-initializes at module load.
        const mod = await import("sudachi");
        if (typeof (mod as unknown as SudachiModule).tokenize === "function") {
          return mod as unknown as SudachiModule;
        }
        logger.warn({}, "sudachi module loaded but API not recognized; falling back to whitespace split");
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
    // Mode C (= 2) yields the longest/most-natural segmentation — best for recall.
    const MODE_C = sudachi.TokenizeMode?.C ?? 2;
    const raw = sudachi.tokenize(text, MODE_C);
    // sudachi@0.1.x returns a JSON string: [{surface, poses, ...}, ...]
    const morphemes: Array<{ surface: string; poses: string[] }> = JSON.parse(raw);
    const surfaces = morphemes
      .map((m) => m.surface)
      .filter((s) => s.trim().length > 0);
    if (surfaces.length > 0) return surfaces.join(" ");
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
