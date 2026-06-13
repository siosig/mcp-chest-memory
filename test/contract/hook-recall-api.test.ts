import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/http/app.js";
import { HookRecallFacade } from "../../src/lib/recall/hook-recall-facade.js";
import type { NormalizedHookRecallRequest } from "../../src/schemas/hook-recall.js";
import { hookMemory } from "../fixtures/hook-recall.js";

class FakeHookRecallFacade extends HookRecallFacade {
  public requests: NormalizedHookRecallRequest[] = [];

  constructor() {
    super({
      async recall(): Promise<never> {
        throw new Error("unused");
      },
    });
  }

  override async recall(request: NormalizedHookRecallRequest): Promise<Awaited<ReturnType<HookRecallFacade["recall"]>>> {
    this.requests.push(request);
    return { ok: true, notice: "untrusted", memories: [hookMemory()] };
  }
}

const TOKEN = "hook-token-123";

function authHeaders(token: string = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("hook recall API contract", () => {
  test("requires bearer auth without disclosing memory content", async () => {
    const facade = new FakeHookRecallFacade();
    const app = createApp({ token: TOKEN, hookRecallFacade: facade, version: "test" });
    const res = await app.request("/api/hooks/recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "remote recall" }),
    });
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.equal(text.includes("Prefer the shared recall service"), false);
  });

  test("normalizes request defaults and returns bounded summaries", async () => {
    const facade = new FakeHookRecallFacade();
    const app = createApp({ token: TOKEN, hookRecallFacade: facade, version: "test" });
    const res = await app.request("/api/hooks/recall", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query: "remote recall", project: "mcp-chest-memory" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: true; memories: Array<{ layer: string; content: string }> };
    assert.equal(body.ok, true);
    assert.equal(body.memories.length, 1);
    assert.equal(facade.requests[0]?.project, "mcp-chest-memory");
    assert.deepEqual(facade.requests[0]?.layers, ["realize", "learning"]);
    assert.equal(facade.requests[0]?.limit, 8);
  });

  test("rejects invalid request JSON shape", async () => {
    const facade = new FakeHookRecallFacade();
    const app = createApp({ token: TOKEN, hookRecallFacade: facade, version: "test" });
    const res = await app.request("/api/hooks/recall", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query: "" }),
    });
    assert.equal(res.status, 400);
  });
});
