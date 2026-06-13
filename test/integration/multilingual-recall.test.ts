// Multilingual recall through the FTS5 unicode61 path (with pre-tokenized content).
// Japanese and Chinese require space-separated tokens in content_tokenized
// (produced by Sudachi in production; supplied manually in tests).
// English uses unicode61's built-in word-boundary splitting.
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
  // Japanese: content_tokenized must contain space-separated morphemes so that
  // the unicode61 FTS index can find individual tokens.
  // (In production Sudachi produces this; here we supply it manually.)
  jaId = await insMemory(eid, "認証トークンの有効期限は二十四時間で失効する", {
    contentTokenized: "認証 トークン の 有効 期限 は 二十四 時間 で 失効 する",
  });
  // English: unicode61 splits on word boundaries naturally — no manual tokenization needed.
  enId = await insMemory(eid, "the authentication token expires after twenty four hours");
  // Chinese: same as Japanese — needs space-separated tokens for unicode61 FTS.
  zhId = await insMemory(eid, "认证令牌的有效期限是二十四小时之后过期", {
    contentTokenized: "认证 令牌 的 有效期限 是 二十四 小时 之后 过期",
  });
});

async function recallIds(query: string): Promise<number[]> {
  const res = JSON.parse(
    await handleChestRecall({ query } as Parameters<typeof handleChestRecall>[0], noVector),
  ) as RecallResult;
  assert.equal(res.ok, true);
  return res.memories.map((m) => m.id);
}

describe("multilingual recall (FTS5 unicode61 + tokenized)", () => {
  test("Japanese query finds the Japanese memory", async () => {
    const ids = await recallIds("有効期限 トークン");
    assert.ok(ids.includes(jaId), `expected ${jaId} in ${JSON.stringify(ids)}`);
  });

  test("English query finds the English memory", async () => {
    const ids = await recallIds("authentication expires");
    assert.ok(ids.includes(enId), `expected ${enId} in ${JSON.stringify(ids)}`);
  });

  test("Chinese query finds the Chinese memory", async () => {
    const ids = await recallIds("认证 令牌");
    assert.ok(ids.includes(zhId), `expected ${zhId} in ${JSON.stringify(ids)}`);
  });
});
