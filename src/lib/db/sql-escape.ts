// SQL LIKE-pattern escaping.
//
// SQLite LIKE has no default escape character, so user-supplied `%` and `_`
// otherwise act as wildcards — e.g. a query of "%" matches every row. Callers
// escape the value with escapeLike(), wrap it in their own `%…%`, bind it as a
// `?` parameter, and append the LIKE_ESCAPE clause so the escaped characters
// match literally.
//
// Usage:
//   sql += ` AND col LIKE ? ${LIKE_ESCAPE}`;
//   params.push(`%${escapeLike(userValue)}%`);

/** Backslash is the escape character declared by LIKE_ESCAPE. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Append after a `LIKE ?` clause whose bound value was escaped via escapeLike. */
export const LIKE_ESCAPE = "ESCAPE '\\'";
