// Credential redaction applied exactly once at the taint boundary before
// external input is persisted to the database:
//   - import-sessions (Stop hook auto-capture)
//   - chest_remember / chest_update_memory (MCP tools)
// Derivative writes such as consolidate are excluded because their input
// is already redacted.

export interface RedactResult {
  /** When redactedCount === 0 the text is identical to the input (idempotent). */
  text: string;
  redactedCount: number;
}

export const REDACTED = "[REDACTED]";

// Credential key names to detect. Hyphen/underscore variants are absorbed by [-_]?;
// case is ignored via the `i` flag. Longer patterns appear first to prefer the longest match.
const KEY_PATTERN = [
  "authorization",
  "auth[-_]?token",
  "access[-_]?token",
  "refresh[-_]?token",
  "client[-_]?secret",
  "private[-_]?key",
  "x[-_]?api[-_]?key",
  "api[-_]?key",
  "apikey",
  "set[-_]?cookie",
  "cookie",
  "signature",
  "password",
  "passwd",
  "pwd",
  "secret",
  "bearer",
  "token",
].join("|");

// HTTP header-style keys: values may contain spaces (e.g. Bearer <token> / k=v; k2=v2),
// so the entire rest of the line is replaced.
const HEADER_KEY_PATTERN = ["authorization", "set[-_]?cookie", "cookie"].join("|");
const HEADER_RE = new RegExp(
  `(?<hprefix>(?:${HEADER_KEY_PATTERN})[ \\t]*:[ \\t]*)(?<hval>[^\\r\\n]+)`,
  "gi",
);

// key=value pattern (env vars / CLI args / YAML / JSON).
// - Separator: `=` or `:` with optional horizontal whitespace only (no newline crossing).
// - Value: quoted ('…' / "…") — replaces only the quoted content;
//          unquoted — replaces up to the next whitespace / comma / closing bracket.
// - Empty values (e.g. `password=` immediately followed by end-of-line) are left unchanged.
const QUOTED = `(?<q>["'])(?<qval>(?:(?!\\k<q>).)+)\\k<q>`;
const BARE = `(?<bval>[^\\s"',;)}\\]]+)`;
const KV_RE = new RegExp(
  `(?<prefix>["']?(?:${KEY_PATTERN})["']?[ \\t]*[:=][ \\t]*)(?:${QUOTED}|${BARE})`,
  "gi",
);

// PEM private key blocks. The entire block including BEGIN/END markers is replaced,
// because leaving the header line would provide a reconstruction hint for the base64 body.
const PEM_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * Pure function that replaces credential values with [REDACTED].
 * Text containing no credentials is returned unchanged (redactedCount=0, text === input).
 * Applying this function to already-redacted text is a no-op (idempotent).
 */
export function redactCredentials(input: string): RedactResult {
  let count = 0;

  // 1) PEM blocks first (before key=value, so the "KEY" token inside the block
  //    is not picked up by KV_RE before being suppressed)
  let text = input.replace(PEM_RE, () => {
    count++;
    return REDACTED;
  });

  // 2) HTTP header keys (Authorization / Cookie / Set-Cookie): replace to end of line
  text = text.replace(HEADER_RE, (...args) => {
    const match = args[0] as string;
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    const hval = groups.hval ?? "";
    if (hval.startsWith("[REDACTED")) return match;
    count++;
    return `${groups.hprefix ?? ""}${REDACTED}`;
  });

  // 3) key=value
  text = text.replace(KV_RE, (...args) => {
    const match = args[0] as string;
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    const prefix = groups.prefix ?? "";
    const q = groups.q;
    const inner = q !== undefined ? groups.qval : groups.bval;
    // Already redacted — return the original match unchanged (idempotent).
    // The bare-value character class excludes `]`, so `[REDACTED` is a partial
    // match; use startsWith to detect and return the full original match.
    if (inner !== undefined && inner.startsWith("[REDACTED")) return match;
    count++;
    return q !== undefined ? `${prefix}${q}${REDACTED}${q}` : `${prefix}${REDACTED}`;
  });

  return count === 0 ? { text: input, redactedCount: 0 } : { text, redactedCount: count };
}

/** Convenience helper: redact and return only the resulting string. */
export function redactText(input: string): string {
  return redactCredentials(input).text;
}
