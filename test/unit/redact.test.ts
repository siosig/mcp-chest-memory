// Unit tests for redactCredentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactCredentials, redactText, REDACTED } from "../../src/lib/redact.js";

// ---------------------------------------------------------------------------
// Key names × format variations
// ---------------------------------------------------------------------------

const KEYS = [
  "authorization",
  "auth_token",
  "access_token",
  "refresh_token",
  "bearer",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "api_key",
  "apikey",
  "x_api_key",
  "cookie",
  "set_cookie",
  "signature",
  "private_key",
  "client_secret",
];

test("env format: all key names redact value to [REDACTED] while preserving the key name", () => {
  for (const key of KEYS) {
    const r = redactCredentials(`${key}=sUp3rS3cretV4lue`);
    assert.equal(r.text, `${key}=${REDACTED}`, `key=${key}`);
    assert.equal(r.redactedCount, 1, `key=${key}`);
  }
});

test("case and hyphen variants are also detected", () => {
  assert.equal(redactText("API_KEY='AIzaSyB-abc123'"), `API_KEY='${REDACTED}'`);
  assert.equal(redactText("Api-Key: xyz789"), `Api-Key: ${REDACTED}`);
  assert.equal(redactText("CLIENT-SECRET=foo"), `CLIENT-SECRET=${REDACTED}`);
  assert.equal(redactText("X-Api-Key: abc"), `X-Api-Key: ${REDACTED}`);
});

test("JSON format: only the value is replaced; JSON syntax is preserved", () => {
  assert.equal(
    redactText('{"password": "hunter2", "user": "alice"}'),
    `{"password": "${REDACTED}", "user": "alice"}`,
  );
  assert.equal(
    redactText('"refresh_token":"eyJhbGciOi..."'),
    `"refresh_token":"${REDACTED}"`,
  );
});

test("YAML format: colon-separated value is replaced, key retained", () => {
  assert.equal(redactText("password: hunter2"), `password: ${REDACTED}`);
  assert.equal(
    redactText("db:\n  password: hunter2\n  host: buildhost"),
    `db:\n  password: ${REDACTED}\n  host: buildhost`,
  );
});

test("HTTP headers: the entire value of an Authorization line is replaced", () => {
  assert.equal(
    redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y"),
    `Authorization: ${REDACTED}`,
  );
  assert.equal(redactText("Cookie: session=abc; theme=dark"), `Cookie: ${REDACTED}`);
});

test("CLI format: --flag=value and quoted values are redacted", () => {
  assert.equal(redactText("--api-key=AIza123"), `--api-key=${REDACTED}`);
  assert.equal(redactText(`export TOKEN="ghp_abc123"`), `export TOKEN="${REDACTED}"`);
});

// ---------------------------------------------------------------------------
// PEM blocks
// ---------------------------------------------------------------------------

test("PEM: the entire block is replaced with [REDACTED]", () => {
  const pem = [
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
    "dGVzdGtleWJvZHlsaW5lMg==",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const r = redactCredentials(`before\n${pem}\nafter`);
  assert.equal(r.text, `before\n${REDACTED}\nafter`);
  assert.equal(r.redactedCount, 1);
});

test("PEM: qualified headers (RSA / EC) are also detected", () => {
  const rsa = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
  const ec = "-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----";
  assert.equal(redactText(rsa), REDACTED);
  assert.equal(redactText(ec), REDACTED);
});

test("PEM: public key / certificate blocks are not redacted", () => {
  const pub = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
  assert.equal(redactText(pub), pub);
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

test("empty value (password= at end-of-line or whitespace) is not redacted", () => {
  assert.equal(redactText("password="), "password=");
  assert.equal(redactText("password= \nnext"), "password= \nnext");
});

test("multiple credentials mixed in one string: all are redacted", () => {
  const r = redactCredentials(
    `API_KEY=aaa\npassword: bbb\nAuthorization: Bearer ccc`,
  );
  assert.equal(r.redactedCount, 3);
  assert.ok(!r.text.includes("aaa") && !r.text.includes("bbb") && !r.text.includes("ccc"));
});

test("no credentials present: string is unchanged", () => {
  const samples = [
    "chest-index.timer を 5 分毎に変更した",
    "RRF (k=60) で FTS と vector を融合する設計にした",
    "const x = tokenize(input); // token という語自体は無害...ではない場合もある",
    "日本語のみの通常テキスト。絵文字 🎉 も含む。",
  ];
  for (const s of samples) {
    const r = redactCredentials(s);
    if (r.redactedCount === 0) assert.equal(r.text, s);
  }
  // completely harmless text → redactedCount=0 and text unchanged
  const plain = "ただの作業メモ。秘密情報なし。";
  const r = redactCredentials(plain);
  assert.equal(r.redactedCount, 0);
  assert.equal(r.text, plain);
});

test("idempotent: re-applying redact to already-redacted text produces no change", () => {
  const once = redactText("api_key=secret123\npassword: hunter2");
  const twice = redactText(once);
  assert.equal(twice, once);
});

test("key name and surrounding context are preserved", () => {
  const r = redactText("設定: GEMINI_API_KEY='AIza...' を .env に書く");
  assert.ok(r.includes("GEMINI_API_KEY"));
  assert.ok(r.includes("を .env に書く"));
  assert.ok(!r.includes("AIza"));
});
