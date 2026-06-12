// Synchronous query embedding for recall, with a hard timeout.
// Any failure (model unavailable, missing API key, API error, timeout)
// resolves to null and recall degrades gracefully to FTS+LIKE only.

import { activeProvider } from "./provider.js";
import { geminiEmbedSingle, type SingleEmbedClient } from "./gemini-provider.js";
import { logger } from "../../utils/logger.js";

export interface EmbedQueryOpts {
  /** Test injection point: a fake client compatible with models.embedContent. */
  client?: SingleEmbedClient;
}

/**
 * Embed one query with an upper time bound. On timeout the result is
 * discarded (the losing promise has no side effects — read-only API call).
 */
export async function embedQueryWithTimeout(
  text: string,
  timeoutMs: number,
  opts: EmbedQueryOpts = {},
): Promise<number[] | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn({ timeoutMs }, "query embedding timed out, falling back to FTS only");
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([embedQueryOnce(text, opts), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function embedQueryOnce(
  text: string,
  opts: EmbedQueryOpts = {},
): Promise<number[] | null> {
  // An injected client always wins (unit tests drive the gemini path directly).
  if (opts.client) {
    return geminiEmbedSingle(text, "RETRIEVAL_QUERY", opts.client);
  }
  return activeProvider().embedQuery(text);
}
