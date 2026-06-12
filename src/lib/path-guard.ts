// Small, side-effect-free path containment check. Returns true iff `child`
// equals `parent` or sits underneath it, using a separator-aware prefix test so
// "/a/projects-evil" is not treated as inside "/a/projects". Callers should pass
// already-canonicalized (realpath) absolute paths.
import { sep } from "node:path";

export function isPathInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}
