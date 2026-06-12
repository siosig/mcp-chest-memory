// Multilingual recall through the FTS5 trigram path: Japanese, English, and
// Chinese (no whitespace segmentation) must each be searchable in their own
// language without a morphological analyzer.
import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";

interface RecallResult {
  ok: boolean;
  count: number;
  memories: Array<{ id: number; content: unknown }>;
}

const noVector = { embedQuery: async () => null };

let jaId = 0;
let enId = 0;
let zhId = 0;

before(async () => {
  await resetDb();
  const eid = await insEntity("project", "multilingual");
  jaId = await insMemory(eid, "認証トークンの有効期限は二十四時間で失効する");
  enId = await insMemory(eid, "the authentication token expires after twenty four hours");
  zhId = await insMemory(eid, "认证令牌的有效期限是二十四小时之后过期");
});

async function recallIds(query: string): Promise<number[]> {
  const res = JSON.parse(
    await handleChestRecall({ query } as Parameters<typeof handleChestRecall>[0], noVector),
  ) as RecallResult;
  assert.equal(res.ok, true);
  return res.memories.map((m) => m.id);
}

describe("multilingual recall (FTS5 trigram)", () => {
  test("Japanese query finds the Japanese memory", async () => {
    const ids = await recallIds("有効期限 トークン");
    assert.ok(ids.includes(jaId), `expected ${jaId} in ${JSON.stringify(ids)}`);
  });

  test("English query finds the English memory", async () => {
    const ids = await recallIds("authentication expires");
    assert.ok(ids.includes(enId), `expected ${enId} in ${JSON.stringify(ids)}`);
  });

  test("Chinese query (no spaces) finds the Chinese memory", async () => {
    const ids = await recallIds("认证令牌");
    assert.ok(ids.includes(zhId), `expected ${zhId} in ${JSON.stringify(ids)}`);
  });
});
