// Synchronous query embedding for recall, with a hard timeout.
// Any failure (model unavailable, timeout) resolves to null and recall
// degrades gracefully to FTS+LIKE only.

import { activeProvider } from "./provider.js";
import { logger } from "../../utils/logger.js";

/**
 * Embed one query with an upper time bound. On timeout the result is
 * discarded (the losing promise has no side effects).
 */
export async function embedQueryWithTimeout(
  text: string,
  timeoutMs: number,
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
    return await Promise.race([activeProvider().embedQuery(text), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
