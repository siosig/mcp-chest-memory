// T040: integration test for `chest-index fetch-model`.
//
// We intercept global `fetch` so the test never hits Hugging Face, and verify:
//   (a) clean download writes via `.tmp` then renames
//   (b) cached files are skipped
//   (c) zero-byte `.onnx` / `.json` artifacts and any `.tmp` are purged
//   (d) `--reranker` triggers a second model
//   (e) the ModelFetchReport conforms to the documented shape

import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  atomicDownload,
  modelDirFor,
  purgePartialFiles,
  runFetchModelDetailed,
} from "../../src/bin/fetch-model.js";
import { resetEnvCacheForTest } from "../../src/utils/env.js";

const ORIGINAL_FETCH = globalThis.fetch;

function fakeResponse(body: Uint8Array, status = 200): Response {
  return new Response(body, { status, statusText: status === 200 ? "OK" : "error" });
}

interface FetchCall {
  url: string;
}

function installFakeFetch(payloadByPath: Map<string, Uint8Array>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    for (const [pathSuffix, payload] of payloadByPath.entries()) {
      if (url.endsWith(pathSuffix)) {
        return fakeResponse(payload);
      }
    }
    return fakeResponse(new Uint8Array(), 404);
  }) as typeof fetch;
  return calls;
}

function setupTempCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "chest-fetch-model-"));
  process.env.CHEST_DATA_DIR = root;
  process.env.CHEST_DB_PATH = join(root, "chest.db");
  process.env.CHEST_EMBED_MODEL = "Xenova/bge-m3";
  delete process.env.HF_ENDPOINT;
  delete process.env.CHEST_RERANK_ENABLED;
  resetEnvCacheForTest();
  return root;
}

describe("fetch-model", () => {
  beforeEach(() => {
    setupTempCacheRoot();
  });

  after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("downloads files atomically and writes a JSON report", async () => {
    const payload = new TextEncoder().encode('{"hello":"world"}\n');
    const onnxPayload = new Uint8Array([0x4f, 0x4e, 0x4e, 0x58]);
    const map = new Map<string, Uint8Array>([
      ["Xenova/bge-m3/resolve/main/config.json", payload],
      ["Xenova/bge-m3/resolve/main/tokenizer.json", payload],
      ["Xenova/bge-m3/resolve/main/tokenizer_config.json", payload],
      ["Xenova/bge-m3/resolve/main/special_tokens_map.json", payload],
      ["Xenova/bge-m3/resolve/main/sentencepiece.bpe.model", payload],
      ["Xenova/bge-m3/resolve/main/onnx/model_quantized.onnx", onnxPayload],
    ]);
    const calls = installFakeFetch(map);

    const { code, report } = await runFetchModelDetailed({ json: true });
    assert.equal(code, 0, "exit code 0 expected");
    assert.equal(calls.length, 6, "one fetch per required file");

    const modelDir = modelDirFor("Xenova/bge-m3");
    const configPath = join(modelDir, "config.json");
    const onnxPath = join(modelDir, "onnx", "model_quantized.onnx");
    assert.ok(existsSync(configPath));
    assert.ok(existsSync(onnxPath));
    assert.equal(statSync(configPath).size, payload.length);
    assert.equal(statSync(onnxPath).size, onnxPayload.length);
    assert.ok(!existsSync(`${configPath}.tmp`));
    assert.ok(!existsSync(`${onnxPath}.tmp`));

    assert.equal(report.exit_code, 0);
    assert.deepEqual(report.models, ["Xenova/bge-m3"]);
    assert.equal(report.results.length, 6);
    for (const r of report.results) {
      assert.equal(r.model_id, "Xenova/bge-m3");
      assert.equal(r.status, "downloaded");
      assert.ok(r.bytes > 0);
    }
    assert.ok(report.total_bytes > 0);
    assert.match(report.started_at, /\d{4}-\d{2}-\d{2}T/);
    assert.match(report.finished_at, /\d{4}-\d{2}-\d{2}T/);
  });

  it("reports `cached` for files already on disk and issues no HTTP calls", async () => {
    const modelDir = modelDirFor("Xenova/bge-m3");
    mkdirSync(join(modelDir, "onnx"), { recursive: true });
    const cachedBytes = new TextEncoder().encode("cached");
    for (const f of [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "sentencepiece.bpe.model",
    ]) {
      writeFileSync(join(modelDir, f), cachedBytes);
    }
    writeFileSync(join(modelDir, "onnx", "model_quantized.onnx"), cachedBytes);

    const calls = installFakeFetch(new Map());
    const { code, report } = await runFetchModelDetailed({ json: true });
    assert.equal(code, 0);
    assert.equal(calls.length, 0, "no HTTP calls when fully cached");
    for (const r of report.results) {
      assert.equal(r.status, "cached");
    }
  });

  it("purges zero-byte files and `.tmp` leftovers before downloading", async () => {
    const modelDir = modelDirFor("Xenova/bge-m3");
    mkdirSync(join(modelDir, "onnx"), { recursive: true });
    writeFileSync(join(modelDir, "onnx", "model_quantized.onnx"), new Uint8Array());
    writeFileSync(join(modelDir, "config.json"), new Uint8Array());
    writeFileSync(join(modelDir, "tokenizer.json.tmp"), new TextEncoder().encode("partial"));

    const removed = await purgePartialFiles(modelDir);
    assert.equal(removed, 3, "all three partial artifacts must be removed");
    const remaining = readdirSync(modelDir);
    assert.ok(!remaining.includes("config.json"));
    assert.ok(!remaining.includes("tokenizer.json.tmp"));
  });

  it("processes the reranker model when --reranker is set", async () => {
    const payload = new TextEncoder().encode("x");
    const m = new Map<string, Uint8Array>();
    for (const f of [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "sentencepiece.bpe.model",
      "onnx/model_quantized.onnx",
    ]) {
      m.set(`Xenova/bge-m3/resolve/main/${f}`, payload);
    }
    for (const f of [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "sentencepiece.bpe.model",
      "onnx/model_q4.onnx",
    ]) {
      m.set(`onnx-community/bge-reranker-v2-m3-ONNX/resolve/main/${f}`, payload);
    }
    const calls = installFakeFetch(m);
    const { code, report } = await runFetchModelDetailed({ json: true, reranker: true });
    assert.equal(code, 0);
    assert.equal(calls.length, 12, "6 files per model x 2 models");
    assert.equal(report.models.length, 2);
    assert.ok(report.models.includes("onnx-community/bge-reranker-v2-m3-ONNX"));
  });

  it("atomicDownload writes via .tmp and renames on success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chest-atomic-"));
    const dest = join(dir, "out.bin");
    const payload = new TextEncoder().encode("hello atomic");
    installFakeFetch(new Map([["/probe", payload]]));
    const n = await atomicDownload("https://example.test/probe", dest);
    assert.equal(n, payload.length);
    assert.ok(existsSync(dest));
    assert.ok(!existsSync(`${dest}.tmp`));
    assert.equal(statSync(dest).size, payload.length);
  });
});
