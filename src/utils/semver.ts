// Minimal semver comparison helper — no external dependency.
//
// Supports the `MAJOR.MINOR.PATCH` core only. Pre-release and build metadata
// (the parts after `-` or `+`) are stripped and ignored. Non-numeric or
// missing components are coerced to 0. This is sufficient for the
// `min_required_client_version` compatibility check used by the doctor
// client and pending-resync flows; tighter semver semantics would require
// a real semver dependency, which the constitution forbids adding.

function parse(v: string): [number, number, number] {
  const core = v.trim().replace(/^v/, "").split(/[-+]/)[0] ?? "";
  const parts = core.split(".");
  const n = (s: string | undefined): number => {
    const x = Number.parseInt(s ?? "0", 10);
    return Number.isFinite(x) ? x : 0;
  };
  return [n(parts[0]), n(parts[1]), n(parts[2])];
}

/** Returns true when version `a` is strictly less than version `b`. */
export function lt(a: string, b: string): boolean {
  const [aa, ab, ac] = parse(a);
  const [ba, bb, bc] = parse(b);
  if (aa !== ba) return aa < ba;
  if (ab !== bb) return ab < bb;
  return ac < bc;
}

/** Returns true when version `a` is greater than or equal to version `b`. */
export function gte(a: string, b: string): boolean {
  return !lt(a, b);
}
