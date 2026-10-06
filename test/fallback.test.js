import assert from "node:assert/strict";
import test from "node:test";
import { Media } from "@opencode/ai";
import plugin from "../index.js";
import { createImageFallback } from "../fallback.js";
import { resolveConnection } from "../connection.js";
import { event, file, harness, image, media } from "./fixtures.js";

// A mistaken real network call fails immediately instead of contacting a server.
globalThis.fetch = async () => { throw new Error("Network forbidden in isolated tests"); };

function prepare(options) {
  const h = harness(options);
  return { ...h, rewrite: createImageFallback(h.ctx, h.dependencies) };
}

test("SDK {location,data} model response replaces attachments without changing history", async () => {
  const h = prepare();
  const e = event([media]);
  const history = e.messages;
  Object.freeze(history[0].content);
  Object.freeze(history[0]);
  Object.freeze(history);
  await h.rewrite(e);
  assert.equal(history[0].content[0], media);
  assert.match(e.messages[0].content[0].text, /untrusted visual content.*\nA button/s);
  assert.equal(h.calls[0][1], image);
});

test("image-capable selection bypasses ALL fallback config/credential requests", async () => {
  const h = prepare();
  h.ctx.provider.get = () => { throw new Error("must bypass"); };
  h.models[2].enabled = false;
  const e = event([media], { providerID: "coding", id: "vision" });
  const history = e.messages;
  await h.rewrite(e);
  assert.equal(e.messages, history);
  assert.equal(h.calls.length, 0);
  assert.equal(h.credentialCalls.length, 0);
});

test("no-image request does not read catalogs or resolve credentials", async () => {
  const h = prepare();
  h.ctx.model.list = () => { throw new Error("unexpected"); };
  await h.rewrite(event([{ type: "text", text: "hello" }]));
  assert.equal(h.calls.length, 0);
});

test("unknown selected capability and wrong SDK response fail closed", async () => {
  const h = prepare();
  await assert.rejects(h.rewrite(event([media], { providerID: "unknown", id: "x" })), /capabilities are unknown/);
  h.ctx.model.list = async () => h.models;
  await assert.rejects(h.rewrite(event()), /unexpected model catalog response/);
  assert.equal(h.calls.length, 0);
});

test("disabled or text-only fallback never forwards an image", async () => {
  for (const vision of [{ enabled: false }, { capabilities: { input: ["text"] } }]) {
    const h = prepare({ vision });
    await assert.rejects(h.rewrite(event()), /unavailable or does not accept images/);
    assert.equal(h.calls.length, 0);
  }
});

test("SDK tool-result content uses file.uri/mime and preserves IDs and non-images", async () => {
  const h = prepare();
  const pdf = { type: "file", uri: "data:application/pdf;base64,aA==", mime: "application/pdf" };
  const tool = { type: "tool-result", id: "call-fixture", name: "read", result: { type: "content", value: [file, pdf] } };
  const e = event([tool]);
  await h.rewrite(e);
  const rewritten = e.messages[0].content[0];
  assert.equal(rewritten.id, tool.id);
  assert.equal(rewritten.result.value[0].type, "text");
  assert.equal(rewritten.result.value[1], pdf);
  assert.equal(tool.result.value[0], file);
});

test("decoded SDK Asset supports bytes and base64 inline sources", async () => {
  const h = prepare();
  const base64 = image.split(",")[1];
  for (const source of [
    { type: "base64", mediaType: "image/png", data: base64 },
    { type: "bytes", mediaType: "image/png", data: Buffer.from(base64, "base64") },
  ]) await h.rewrite(event([{ type: "media", media: Media.from(source) }]));
  assert.equal(h.calls.length, 1);
});

test("old history and every request kind use the same outgoing-only hook", async () => {
  const h = harness();
  const hooks = new Map();
  h.ctx.session = { hook: async (kind, fn) => { hooks.set(kind, fn); } };
  const cleanup = await plugin.setup(h.ctx);
  assert.deepEqual([...hooks.keys()], ["context", "compaction", "generate", "title"]);
  // Setup never registers a prompt hook or a registry transform.
  for (const rewrite of hooks.values()) {
    const e = event([{ type: "text", text: "old turn" }, media]);
    e.messages.push({ role: "user", content: [{ type: "text", text: "later turn" }] });
    const history = e.messages;
    // Vision-capable target exercises real registered hook without inference.
    e.model = { providerID: "coding", id: "vision" };
    await rewrite(e);
    assert.equal(e.messages, history);
  }
  await cleanup();
});

test("cache deduplicates attachments/tool history/continuations within a session", async () => {
  const h = prepare();
  await Promise.all([h.rewrite(event([media, media])), h.rewrite(event([media]))]);
  await h.rewrite(event([{ type: "tool-result", id: "x", name: "read", result: { type: "content", value: [file] } }]));
  assert.equal(h.calls.length, 1);
  await h.rewrite(event([media], undefined, "another-session"));
  assert.equal(h.calls.length, 2);
});

test("bounded LRU cache evicts oldest description and cleanup clears it", async () => {
  const h = prepare({ options: { cacheEntries: 1 } });
  await h.rewrite(event());
  await h.rewrite(event([{ ...file, uri: "data:image/png;base64,aGVsbG8=" }]));
  await h.rewrite(event());
  assert.equal(h.calls.length, 3);
  await h.rewrite.clear();
  await h.rewrite(event());
  assert.equal(h.calls.length, 4);
});

test("connection/key rotation invalidates cached descriptions", async () => {
  const h = prepare();
  await h.rewrite(event());
  h.models[2].settings.apiKey = "rotated-fixture-key";
  await h.rewrite(event());
  assert.equal(h.calls.length, 2);
});

test("failures are atomic, sanitized, removed from cache, and retryable", async () => {
  let calls = 0;
  const h = prepare({ generate: async () => {
    if (++calls === 2) return "Success";
    throw new Error(`fixture-secret ${image}`);
  } });
  const e = event([media, { ...file, uri: "https://private.example.invalid/image" }]);
  const history = e.messages;
  await assert.rejects(h.rewrite(e), (error) => {
    assert.doesNotMatch(error.message, /fixture-secret|base64/);
    return /inference failed/.test(error.message);
  });
  assert.equal(e.messages, history);
  await h.rewrite(event());
  assert.equal(calls, 2);
  // A later image failing cannot partially commit earlier replacements.
  await assert.rejects(h.rewrite(e), /inline/);
  assert.equal(e.messages, history);
});

test("empty, non-text, and excessive descriptions are explicit failures", async () => {
  for (const text of ["", " ", null, {}, "x".repeat(17)]) {
    const h = prepare({ options: { maxDescriptionChars: 16 }, generate: async () => text });
    await assert.rejects(h.rewrite(event()), /invalid description/);
  }
});

test("remote/ref media, bad encoding, MIME, and oversized inputs are not fetched", async () => {
  const h = prepare({ options: { maxImageBytes: 80 } });
  const parts = [
    { ...file, uri: "https://private.example.invalid/image" },
    { ...file, uri: "data:image/svg+xml;base64,aA==" },
    { ...file, uri: "data:image/png;base64,!!!!" },
    { ...file, uri: `data:image/png;base64,${Buffer.alloc(81).toString("base64")}` },
    { type: "media", media: Media.from({ type: "url", mediaType: "image/png", url: "https://private.example.invalid/image" }) },
    { type: "media", media: Media.from({ type: "ref", mediaType: "image/png", provider: "fixture", id: "private" }) },
  ];
  for (const part of parts) await assert.rejects(h.rewrite(event([part])), /inline|exceeds/);
  assert.equal(h.calls.length, 0);
});

test("inference timeout aborts, fails closed, and never commits late results", async () => {
  let finish;
  const h = prepare({ options: { timeoutMs: 15 }, generate: async (_c, _u, signal) => {
    assert.equal(signal.aborted, false);
    return await new Promise((resolve) => { finish = resolve; });
  } });
  const e = event();
  const history = e.messages;
  await assert.rejects(h.rewrite(e), /timed out/);
  assert.equal(h.calls[0][2].aborted, true);
  finish("late result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(e.messages, history);
});

test("metadata resolution timeout never starts late inference", async () => {
  const h = prepare({ options: { timeoutMs: 10 } });
  let finish;
  h.ctx.provider.get = async () => await new Promise((resolve) => { finish = resolve; });
  const e = event();
  const history = e.messages;
  await assert.rejects(h.rewrite(e), /timed out/);
  finish({ data: h.provider });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(e.messages, history);
  assert.equal(h.calls.length, 0);
});

test("concurrent inference is bounded even when cache entries are evicted", async () => {
  const finishes = [];
  const h = prepare({ options: { cacheEntries: 1, timeoutMs: 1000 }, generate: async () =>
    await new Promise((resolve) => { finishes.push(resolve); }) });
  const requests = Array.from({ length: 8 }, (_, i) => h.rewrite(event([media], undefined, `pending-${i}`)));
  await new Promise((resolve) => setImmediate(resolve));
  try {
    await assert.rejects(h.rewrite(event([media], undefined, "ninth")), /too many pending/);
    assert.equal(h.calls.length, 8);
  } finally {
    for (const finish of finishes) finish("Fixture description");
    await Promise.all(requests);
  }
});

test("configuration is required, validated, and has no default model IDs", () => {
  for (const options of [{ model: null }, { model: "provider/model" }, { model: { providerID: "fixture", id: "vision", variant: "unsupported" } }, { cacheEntries: 0 }, { timeoutMs: -1 }, { maxTokens: NaN }]) {
    assert.throws(() => prepare({ options }), /configure|integer|variants/);
  }
});

test("active connection uses provider integrationID and actual credential {type:key,key}", async () => {
  const connection = { type: "credential", id: "fixture-credential", label: "Fixture", method: "key" };
  const h = prepare({ connection, credential: { type: "key", key: "active-fixture-key", configuration: { tenant: "fixture-tenant" } },
    provider: { integrationID: "shared-integration" } });
  await h.rewrite(event());
  assert.deepEqual(h.credentialCalls, [["active", "shared-integration"], ["resolve", connection]]);
  assert.equal(h.calls[0][0].settings.apiKey, "active-fixture-key");
  assert.equal(h.calls[0][0].settings.tenant, "fixture-tenant");
});

test("SDK environment connection resolves through OpenCode, not process.env guessing", async () => {
  const h = prepare({ connection: { type: "env", name: "FIXTURE_VISION_KEY" }, credential: { type: "key", key: "resolved-env-key" } });
  await h.rewrite(event());
  assert.equal(h.calls[0][0].settings.apiKey, "resolved-env-key");
});

test("OAuth and unresolved/missing credentials fail explicitly", async () => {
  for (const credential of [undefined, { type: "oauth", access: "private", refresh: "private", expires: 999999, methodID: "oauth" }]) {
    const h = prepare({ connection: { type: "credential", id: "fixture", method: "oauth" }, credential });
    await assert.rejects(h.rewrite(event()), /credential could not be resolved|does not support OAuth/);
    assert.equal(h.calls.length, 0);
  }
  const h = prepare({ vision: { settings: {} } });
  await assert.rejects(h.rewrite(event()), /requires an API key/);
});

test("legacy and incorrectly wrapped credential values are not mistaken for SDK keys", async () => {
  for (const credential of [
    { type: "api", key: "legacy-fixture" },
    { data: { type: "key", key: "wrapped-fixture" } },
    { type: "key", apiKey: "wrong-field-fixture" },
  ]) {
    const h = prepare({ connection: { type: "credential", id: "fixture", method: "key" }, credential });
    await assert.rejects(h.rewrite(event()), /unexpected credential shape|requires an API key/);
    assert.equal(h.calls.length, 0);
  }
});

test("SDK credential and catalog errors cannot leak secrets even with matching prefixes", async () => {
  const h = prepare();
  h.ctx.integration.connection.active = async () => { throw new Error(`Vision fallback private-secret ${image}`); };
  await assert.rejects(h.rewrite(event()), (error) => {
    assert.doesNotMatch(error.message, /private-secret|base64/);
    return /resolution failed/.test(error.message);
  });
  h.ctx.model.list = async () => { throw new Error("private-secret"); };
  await assert.rejects(h.rewrite(event()), /could not read/);
});

test("OpenChamber plugins-only overlay preserves resolved global provider/model settings", async () => {
  const h = prepare({ vision: {
    settings: { baseURL: "https://global.example.invalid/v1", apiKey: "global-fixture-key", nested: { a: 1 }, temperature: 0.2 },
    modelID: "deployment-alias", headers: { "X-Tenant": "fixture" }, body: { metadata: { purpose: "fixture" } },
    compatibility: { maxTokensField: "max_tokens" },
  } });
  // The plugin consumes the already-merged SDK response. It never reads an overlay.
  const original = structuredClone(h.models[2]);
  await h.rewrite(event());
  assert.equal(h.calls[0][0].modelID, "deployment-alias");
  assert.deepEqual(h.calls[0][0].settings, { ...original.settings, headers: original.headers, body: original.body });
  assert.deepEqual(h.calls[0][0].compatibility, original.compatibility);
  assert.deepEqual(h.models[2], original);
});

test("materialized model defaults are authoritative; provider values are not remerged", async () => {
  const h = prepare({ provider: {
    settings: { baseURL: "https://wrong.example.invalid", temperature: 0.9 },
    headers: { "X-Wrong": "do-not-restore" }, body: { metadata: { wrong: true } },
  }, vision: { headers: {}, body: {} } });
  const resolved = await resolveConnection(h.ctx, h.models[2]);
  assert.equal(resolved.settings.baseURL, "https://vision.example.invalid/v1");
  assert.deepEqual(resolved.settings.headers, {});
  assert.deepEqual(resolved.settings.body, {});
  assert.equal(resolved.settings.temperature, undefined);
});

test("unsafe overlays, non-native packages, and WebSocket-only fallback fail before inference", async () => {
  for (const vision of [
    { body: { messages: [] } }, { package: "aisdk:@ai-sdk/openai" },
    { settings: { transport: "websocket", apiKey: "fixture" } },
  ]) {
    const h = prepare({ vision });
    await assert.rejects(h.rewrite(event()), /overlay|native|HTTP transport/);
    assert.equal(h.calls.length, 0);
  }
});
