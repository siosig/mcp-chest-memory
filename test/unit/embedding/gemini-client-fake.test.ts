// Behaviour tests for FakeGeminiBatchClient
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FakeGeminiBatchClient,
  ApiError,
} from "../../../src/lib/embedding/gemini-client.js";

describe("FakeGeminiBatchClient", () => {
  it("submit returns a jobName; initial fetch state is pending", async () => {
    const c = new FakeGeminiBatchClient();
    const r = await c.submit(["hello", "world"]);
    assert.match(r.jobName, /^batches\/fake-/);
    assert.equal(c.submitCount, 1);
    const f = await c.fetch(r.jobName);
    assert.equal(f.state, "pending");
    assert.equal(c.fetchCount, 1);
  });

  it("force succeeded → returns 768-dim L2-normalised vectors", async () => {
    const c = new FakeGeminiBatchClient();
    const { jobName } = await c.submit(["a", "b", "cc"]);
    c.force(jobName, { state: "succeeded" });
    const f = await c.fetch(jobName);
    assert.equal(f.state, "succeeded");
    if (f.state !== "succeeded") return;
    assert.equal(f.vectors.length, 3);
    for (const v of f.vectors) {
      assert.equal(v.length, 768, "vector length must be 768");
      const norm = Math.hypot(...v);
      assert.ok(
        Math.abs(norm - 1) < 1e-9,
        `L2 norm ≈ 1 (got ${norm})`,
      );
    }
  });

  it("setSubmitError → next submit throws; subsequent submits recover", async () => {
    const c = new FakeGeminiBatchClient();
    c.setSubmitError(new ApiError("transient", 429, "rate limit"));
    await assert.rejects(
      async () => {
        await c.submit(["x"]);
      },
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.kind, "transient");
        assert.equal(e.httpStatus, 429);
        return true;
      },
    );
    // after throwing once, the error is cleared and the next submit succeeds
    const r = await c.submit(["y"]);
    assert.ok(r.jobName);
  });

  it("force failed → fetch returns failed with errorKind", async () => {
    const c = new FakeGeminiBatchClient();
    const { jobName } = await c.submit(["a"]);
    c.force(jobName, {
      state: "failed",
      errorKind: "transient",
      errorReason: "test failure",
    });
    const f = await c.fetch(jobName);
    assert.equal(f.state, "failed");
    if (f.state !== "failed") return;
    assert.equal(f.errorKind, "transient");
    assert.equal(f.errorReason, "test failure");
  });

  it("force expired → fetch returns permanent expired", async () => {
    const c = new FakeGeminiBatchClient();
    const { jobName } = await c.submit(["a"]);
    c.force(jobName, { state: "expired" });
    const f = await c.fetch(jobName);
    assert.equal(f.state, "expired");
    if (f.state !== "expired") return;
    assert.equal(f.errorKind, "permanent");
  });

  it("same text produces identical vector (deterministic)", async () => {
    const c1 = new FakeGeminiBatchClient();
    const c2 = new FakeGeminiBatchClient();
    const r1 = await c1.submit(["決定論テスト用テキスト"]);
    const r2 = await c2.submit(["決定論テスト用テキスト"]);
    c1.force(r1.jobName, { state: "succeeded" });
    c2.force(r2.jobName, { state: "succeeded" });
    const f1 = await c1.fetch(r1.jobName);
    const f2 = await c2.fetch(r2.jobName);
    assert.equal(f1.state, "succeeded");
    assert.equal(f2.state, "succeeded");
    if (f1.state !== "succeeded" || f2.state !== "succeeded") return;
    assert.deepEqual(f1.vectors[0], f2.vectors[0]);
  });

  it("fetching unknown jobName returns permanent unknown-job error", async () => {
    const c = new FakeGeminiBatchClient();
    const f = await c.fetch("batches/does-not-exist");
    assert.equal(f.state, "failed");
    if (f.state !== "failed") return;
    assert.equal(f.errorKind, "permanent");
    assert.match(f.errorReason, /unknown job/);
  });
});
