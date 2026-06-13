// Deploy hardening static assertions (High-6, Medium-1/5). These guard the
// example deployment config against regressions.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("deploy config hardening", () => {
  it("Dockerfile runs the runtime stage as the non-root node user", () => {
    const df = read("deploy/docker/Dockerfile");
    assert.match(df, /^USER node$/m, "Dockerfile must switch to USER node");
    assert.match(df, /chown -R node:node \/data/, "data dir must be owned by node");
  });

  it("compose runs as node and keeps the documented port mapping", () => {
    const compose = read("deploy/docker/compose.yaml");
    assert.match(compose, /user:\s*"node"/, "compose service must run as node");
    assert.match(compose, /"8765:8765"/, "default port mapping unchanged (per clarification)");
  });

  it("nginx example sets HSTS and a restrictive CSP", () => {
    const nginx = read("deploy/nginx/nginx.conf.example");
    assert.match(nginx, /Strict-Transport-Security/, "HSTS header required");
    assert.match(nginx, /Content-Security-Policy/, "CSP header required");
  });
});
