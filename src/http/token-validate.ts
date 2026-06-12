// Bearer token policy for the REST backend. The backend requires a token and
// enforces a minimum length so a weak/short token cannot guard the memory store.
// The recommended generator (`openssl rand -hex 32` → 64 chars) passes easily.

export const MIN_TOKEN_LENGTH = 32;

export type TokenCheck = { ok: true } | { ok: false; error: string };

export function validateApiToken(token: string | undefined): TokenCheck {
  if (!token) {
    return {
      ok: false,
      error: "CHEST_API_TOKEN is required. Refusing to start without authentication.",
    };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      error: `CHEST_API_TOKEN is too short (${token.length} chars); minimum ${MIN_TOKEN_LENGTH}. Generate one with: openssl rand -hex 32`,
    };
  }
  return { ok: true };
}
