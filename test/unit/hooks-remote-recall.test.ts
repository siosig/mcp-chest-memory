import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { recallRemote } from "../../src/lib/hooks-remote.js";
import { hookMemory } from "../fixtures/hook-recall.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.CHEST_REMOTE_URL = ORIGINAL_ENV.CHEST_REMOTE_URL;
  process.env.CHEST_API_TOKEN = ORIGINAL_ENV.CHEST_API_TOKEN;
});

test("recallRemote sends typed authenticated hook recall requests", async () => {
  process.env.CHEST_REMOTE_URL = "https://chest.example.com/base/";
  process.env.CHEST_API_TOKEN = "token-123";
  let capturedUrl = "";
  let capturedBody: unknown;
  let capturedAuth = "";
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    const headers = new Headers(init?.headers);
    capturedAuth = headers.get("authorization") ?? headers.get("Authorization") ?? "";
    return Response.json({ ok: true, memories: [hookMemory()] });
  };

  const memories = await recallRemote("remote recall", {
    project: "mcp-chest-memory",
    layers: ["realize", "learning"],
    limit: 8,
    max_tokens: 1500,
  });

  assert.equal(capturedUrl, "https://chest.example.com/base/api/hooks/recall");
  assert.equal(capturedAuth, "Bearer token-123");
  assert.deepEqual(capturedBody, {
    query: "remote recall",
    project: "mcp-chest-memory",
    layers: ["realize", "learning"],
    limit: 8,
    max_tokens: 1500,
  });
  assert.equal(memories.length, 1);
});

test("recallRemote throws on non-2xx and malformed response", async () => {
  process.env.CHEST_REMOTE_URL = "https://chest.example.com";
  process.env.CHEST_API_TOKEN = "token-123";
  globalThis.fetch = async (): Promise<Response> => new Response("nope", { status: 500 });
  await assert.rejects(() => recallRemote("remote recall"), /recall remote error 500/);

  globalThis.fetch = async (): Promise<Response> => Response.json({ ok: true, memories: [{ id: "bad" }] });
  await assert.rejects(() => recallRemote("remote recall"));
});
