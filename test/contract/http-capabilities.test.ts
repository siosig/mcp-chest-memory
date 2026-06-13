// Contract: GET /capabilities
// See specs/014-doctor-healthcheck/contracts/http-capabilities.md

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensurePrismaInitialized } from "../../src/lib/db/prisma-client.js";
import { createApp } from "../../src/http/app.js";

const TOKEN = "test-token-32chars-aaaaaaaaaaaaaaaa";

before(async () => {
  await ensurePrismaInitialized();
});

describe("GET /capabilities", () => {
  test("401 without bearer token", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/capabilities");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "unauthorized");
  });

  test("401 with wrong token", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/capabilities", {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(res.status, 401);
  });

  test("200 with valid token, schema-compliant body", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/capabilities", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      api_version: string;
      features: string[];
      server_has_embedder: boolean;
      min_required_client_version: string;
      server_time: string;
    };
    assert.match(body.api_version, /^\d+\.\d+\.\d+$/);
    assert.match(body.min_required_client_version, /^\d+\.\d+\.\d+$/);
    assert.ok(Array.isArray(body.features) && body.features.length > 0);
    for (const f of body.features) assert.match(f, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof body.server_has_embedder, "boolean");
    assert.ok(!Number.isNaN(Date.parse(body.server_time)));
  });

  test("server_has_embedder reflects embed config (sync OR sweep)", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/capabilities", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { server_has_embedder: boolean };
    // server_has_embedder is true unless BOTH write-time embed and the sweep are
    // disabled. It is no longer tied to CHEST_MODE (the backend is always local).
    const syncOn = process.env.CHEST_SYNC_EMBED !== "0";
    const sweepOn =
      process.env.CHEST_AUTO_MAINTENANCE !== "0" && (process.env.CHEST_MODE ?? "local") !== "remote";
    assert.equal(body.server_has_embedder, syncOn || sweepOn);
  });

  test("advertised features include client-embed and pending-resync", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/capabilities", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { features: string[] };
    for (const f of ["client-embed", "pending-resync", "memories-pending-list", "memories-embedding-update"]) {
      assert.ok(body.features.includes(f), `missing feature: ${f}`);
    }
  });
});
