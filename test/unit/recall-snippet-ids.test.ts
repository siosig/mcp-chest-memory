// Acceptance tests for recall snippet_mode / snippet_window / ids wiring.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

// vector path is out of scope for these tests — always returns null (FTS/LIKE only)
const noVec = { embedQuery: async () => null };

const LONG_CONTENT = "x".repeat(600) + " snipkeyword " + "y".repeat(600); // > 1.2KB

describe("recall snippet_mode + ids wiring", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("snippet_mode: long content returns excerpt around query term + content_truncated: true", async () => {
    const eid = await insEntity("project", "snip");
    const m1 = await insMemory(eid, LONG_CONTENT);

    const res = JSON.parse(
      await handleChestRecall({ query: "snipkeyword", snippet_mode: true } as never, noVec),
    );
    assert.equal(res.ok, true);
    const m = res.memories.find((x: any) => x.id === m1);
    assert.ok(m, "record must be returned");
    assert.equal(typeof m.content, "string");
    assert.ok(m.content.includes("snipkeyword"), "snippet must contain query term");
    assert.equal(m.content_truncated, true);
    // default window 240 code points + surrounding ellipsis → much shorter than full (1213 cp)
    assert.ok(Array.from(m.content).length <= 242, `len=${Array.from(m.content).length}`);
  });

  it("snippet_mode: short content (within window) is returned as-is with no content_truncated flag", async () => {
    const eid = await insEntity("project", "snip");
    const m1 = await insMemory(eid, "short snipkeyword body");

    const res = JSON.parse(
      await handleChestRecall({ query: "snipkeyword", snippet_mode: true } as never, noVec),
    );
    const m = res.memories.find((x: any) => x.id === m1);
    assert.equal(m.content, "short snipkeyword body");
    assert.ok(!("content_truncated" in m), "content_truncated key must not be present for non-truncated rows");
  });

  it("snippet_window controls the window width", async () => {
    const eid = await insEntity("project", "snip");
    const m1 = await insMemory(eid, LONG_CONTENT);

    const res = JSON.parse(
      await handleChestRecall(
        { query: "snipkeyword", snippet_mode: true, snippet_window: 40 } as never,
        noVec,
      ),
    );
    const m = res.memories.find((x: any) => x.id === m1);
    assert.equal(m.content_truncated, true);
    assert.ok(Array.from(m.content).length <= 42, `len=${Array.from(m.content).length}`);
    assert.ok(m.content.includes("snipkeyword"));
  });

  it("snippet_mode absent → legacy response: full content, no content_truncated key", async () => {
    const eid = await insEntity("project", "snip");
    const m1 = await insMemory(eid, LONG_CONTENT);

    const res = JSON.parse(await handleChestRecall({ query: "snipkeyword" } as never, noVec));
    const m = res.memories.find((x: any) => x.id === m1);
    assert.equal(m.content, LONG_CONTENT);
    assert.ok(!("content_truncated" in m));
  });

  it("ids: skips query search and fetches by ID directly; always returns full content", async () => {
    const eid = await insEntity("project", "snip");
    const m1 = await insMemory(eid, LONG_CONTENT);
    const m2 = await insMemory(eid, "another full body");

    // ids takes priority over snippet_mode; full content is always returned
    const res = JSON.parse(
      await handleChestRecall({ ids: [m1, m2], snippet_mode: true } as never, noVec),
    );
    assert.equal(res.ok, true);
    assert.equal(res.search, "ids");
    assert.equal(res.count, 2);
    const got1 = res.memories.find((x: any) => x.id === m1);
    const got2 = res.memories.find((x: any) => x.id === m2);
    assert.equal(got1.content, LONG_CONTENT, "ids bypasses snippet: full content returned");
    assert.ok(!("content_truncated" in got1));
    assert.equal(got2.content, "another full body");
  });

  it("ids: archived records excluded by default; restored with include_archived (same contract as query)", async () => {
    const eid = await insEntity("project", "snip");
    const live = await insMemory(eid, "live body");
    const archived = await insMemory(eid, "archived body", {
      archivedAt: Math.floor(Date.now() / 1000) - 60,
    });

    const def = JSON.parse(await handleChestRecall({ ids: [live, archived] } as never, noVec));
    assert.deepEqual(
      def.memories.map((x: any) => x.id),
      [live],
    );

    const withArchived = JSON.parse(
      await handleChestRecall({ ids: [live, archived], include_archived: true } as never, noVec),
    );
    assert.equal(withArchived.count, 2);
  });

  it("neither query nor ids provided → INVALID_INPUT error", async () => {
    await assert.rejects(
      () => handleChestRecall({} as never, noVec),
      (err: any) => err.code === "INVALID_INPUT",
    );
  });
});
