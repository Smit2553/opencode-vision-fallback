import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.js";
import { createVisionClient, VISION_PROMPT } from "../vision.js";
import { SUPPORTED_PACKAGES } from "../connection.js";
import { event, harness, image, media } from "./fixtures.js";

const realFetch = globalThis.fetch;
// No fallthrough: every transport request in this process is synthetic.
globalThis.fetch = async () => { throw new Error("Network forbidden in isolated tests"); };

function chatResponse(text = "A fixture Save button.") {
  return new Response([
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "Content-Type": "text/event-stream" } });
}

test("isolated smoke: registered hooks, real SDK Assets and native adapter, mock SSE transport", async () => {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://vision.example.invalid/v1/chat/completions");
    assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
    const body = await request.json();
    assert.equal(body.model, "deployment-fixture");
    assert.equal(body.messages[0].content[0].text, VISION_PROMPT);
    assert.equal(body.messages[0].content[1].image_url.url, image);
    assert.equal(body.metadata.purpose, "fixture");
    assert.equal(body.max_tokens, 1536);
    assert.equal(request.headers.get("x-tenant"), "fixture-tenant");
    calls.push(body);
    return chatResponse();
  };
  const h = harness({ vision: {
    modelID: "deployment-fixture", headers: { "X-Tenant": "fixture-tenant" },
    body: { metadata: { purpose: "fixture" } }, compatibility: { maxTokensField: "max_tokens" },
  } });
  const hooks = new Map();
  h.ctx.session = { hook: async (name, callback) => { hooks.set(name, callback); } };
  const cleanup = await plugin.setup(h.ctx);
  try {
    for (const [kind, rewrite] of hooks) {
      const e = event();
      // Include a historic image and a later text-only turn.
      e.messages.push({ role: "user", content: [{ type: "text", text: `later ${kind} turn` }] });
      const history = e.messages;
      await rewrite(e);
      assert.match(e.messages[0].content[0].text, /fixture Save button/);
      assert.equal(history[0].content[0], media);
      assert.equal(e.messages[1].content[0], history[1].content[0]);
    }
    assert.equal(calls.length, 1, "all request kinds share a bounded cache");
    const e = event([media], { providerID: "coding", id: "vision" });
    const history = e.messages;
    await hooks.get("context")(e);
    assert.equal(e.messages, history);
    assert.equal(calls.length, 1);
  } finally {
    await cleanup();
    globalThis.fetch = async () => { throw new Error("Network forbidden in isolated tests"); };
  }
});

test("official native client surfaces HTTP and malformed response failures without real network", async () => {
  const client = createVisionClient();
  const connection = { packageID: "@opencode/ai/providers/openai-compatible", modelID: "fixture", settings: {
    apiKey: "fixture-key", baseURL: "https://vision.example.invalid/v1",
  } };
  try {
    for (const response of [
      new Response("fixture-provider-error", { status: 401 }),
      new Response("fixture-provider-error", { status: 429 }),
      new Response("not-json", { headers: { "Content-Type": "application/json" } }),
    ]) {
      globalThis.fetch = async () => response;
      await assert.rejects(client.generate(connection, image, AbortSignal.timeout(1000), 256));
    }
  } finally {
    await client.dispose();
    globalThis.fetch = async () => { throw new Error("Network forbidden in isolated tests"); };
  }
});

test("every allowlisted released native entrypoint implements the declared model factory", async () => {
  for (const packageID of SUPPORTED_PACKAGES) {
    const adapter = await import(packageID);
    const model = adapter.model("fixture-model", { apiKey: "fixture-key", baseURL: "https://vision.example.invalid/v1" });
    assert.ok(model.route);
    assert.equal(model.id, "fixture-model");
  }
});

test.after(() => { globalThis.fetch = realFetch; });
