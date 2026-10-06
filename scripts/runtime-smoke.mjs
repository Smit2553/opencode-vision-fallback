// Opt-in real V2 runtime test. No real provider or existing OpenCode service is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
if (process.argv[2] !== "--child") {
  assert.ok(process.argv[2], "Pass a disposable directory containing @opencode/sdk@2.0.24.");
  const sdkDirectory = resolve(process.argv[2]);
  const pluginDirectory = process.argv[3] ? resolve(process.argv[3]) : repository;
  const metadata = JSON.parse(await readFile(join(sdkDirectory, "node_modules/@opencode/sdk/package.json"), "utf8"));
  assert.equal(metadata.version, "2.0.24", "Use the verified SDK version.");
  await mkdir("/tmp/opencode", { recursive: true });
  const root = await mkdtemp("/tmp/opencode/vision-fallback-runtime-");
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", sdkDirectory, pluginDirectory], {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin", HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      TMPDIR: join(root, "tmp"),
    },
    stdio: "inherit", timeout: 120000,
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const root = process.cwd();
assert.ok(root.startsWith("/tmp/opencode/vision-fallback-runtime-"));
assert.equal(process.env.HOME, join(root, "home"));
for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DB", "OPENCODE_SERVER_URL"]) {
  assert.equal(process.env[key], undefined, "Live environment overrides must not be inherited.");
}
process.env.SYNTHETIC_RUNTIME_KEY = "synthetic-env-key";
for (const path of ["home", "config", "data", "cache", "state", "tmp", "project"]) {
  await mkdir(join(root, path), { recursive: true });
}
const { image } = await import(pathToFileURL(join(repository, "test/fixtures.js")));
const requests = [];
let blockedNonFixtureRequests = 0;
const hookCounts = { context: 0, compaction: 0, generate: 0, title: 0 };
let failVision = false;
const originalFetch = globalThis.fetch;
let endpoint;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!endpoint || url.origin !== endpoint) {
    blockedNonFixtureRequests++;
    throw new Error("Non-fixture network disabled in disposable runtime smoke test");
  }
  return originalFetch(input, init);
};
function sse(response, text) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (body.model === "fixture-vision" && JSON.stringify(body.messages).includes("Describe this image for a text-only coding assistant")) {
    assert.equal(request.headers.authorization, "Bearer synthetic-env-key");
  }
  requests.push(body);
  if (body.model === "fixture-vision" && failVision) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "synthetic failure" } }));
    return;
  }
  if (body.model === "fixture-text" && JSON.stringify(body.messages).includes("USE_SYNTHETIC_TOOL") && !body.messages.some((message) => message.role === "tool")) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "fixture-tool-call", type: "function", function: { name: "fixture_image", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  const summary = "## Objective\n- Synthetic coding response.\n\n## Requirements\n- Synthetic data only.\n\n## Decisions\n- Use a loopback fixture.\n\n## Work State\n### Completed\n- Fixture prompt.\n### Active\n- (none)\n### Blocked\n- (none)\n\n## Next Move\n1. Finish the disposable smoke test.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- A synthetic Save button.";
  sse(response, body.model === "fixture-vision" ? "A synthetic Save button." : JSON.stringify(body.messages).includes("<template>") ? summary : "Synthetic coding response.");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
endpoint = `http://127.0.0.1:${server.address().port}`;
const config = {
  snapshots: false,
  compaction: { auto: false, keep: { tokens: 0 } },
  model: "fixture/text",
  agents: { title: { model: "fixture/text" } },
  permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "fixture_image", resource: "*", effect: "allow" }],
  providers: {
    fixture: {
      env: ["SYNTHETIC_RUNTIME_KEY"],
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `${endpoint}/v1` },
      models: {
        text: { modelID: "fixture-text", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 100000, output: 2000 } },
        vision: { modelID: "fixture-vision", capabilities: { tools: false, input: ["text", "image"], output: ["text"] }, limit: { context: 100000, output: 2000 } },
      },
    },
  },
};
await writeFile(join(root, "config/opencode.jsonc"), JSON.stringify(config));
const overlay = join(root, "overlay.json");
await writeFile(overlay, JSON.stringify({ plugins: [{ package: process.argv[4], options: { model: { providerID: "fixture", id: "vision" } } }] }));
let host;
try {
  const { OpenCode } = await import(pathToFileURL(join(process.argv[3], "node_modules/@opencode/sdk/dist/index.js")));
  host = await OpenCode.create({
    config: { directory: join(root, "config"), project: false, file: overlay },
    database: { path: ":memory:" }, models: { fetch: false, snapshot: false },
    fs: { filewatcher: false, fff: false }, log: { level: "error", emit: () => {} },
    plugins: [{
      id: "runtime-smoke.fixture",
      async setup(ctx) {
        for (const kind of Object.keys(hookCounts)) {
          await ctx.session.hook(kind, () => { hookCounts[kind]++; });
        }
        await ctx.tool.transform((editor) => {
          editor.add({ name: "fixture_image", description: "Return a synthetic image, never read a file.",
            options: { codemode: false }, input: { type: "object", properties: {}, additionalProperties: false },
            async execute() { return { content: [{ type: "file", mime: "image/png", uri: image, name: "synthetic.png" }] }; },
          });
        });
      },
    }],
  });
  const create = (id, title) => host.session.create({ title, location: { directory: join(root, "project") }, model: { providerID: "fixture", id } });
  const wait = (session) => host.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) });
  const prompt = async (session, text, attach = false) => {
    await host.session.prompt({ sessionID: session.id, text, ...(attach ? { files: [{ uri: image, name: "synthetic.png" }] } : {}) });
    await wait(session);
  };
  const session = await create("text", "Disposable runtime smoke");
  await prompt(session, "Describe this synthetic image.", true);
  assert.equal((await host.session.get({ sessionID: session.id })).outcome, "succeeded");
  const coding = requests.filter((body) => body.model === "fixture-text");
  const vision = requests.filter((body) => body.model === "fixture-vision");
  assert.equal(vision.length, 1);
  assert.ok(coding.length >= 1);
  assert.ok(vision[0].messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")));
  assert.ok(JSON.stringify(coding).includes("A synthetic Save button."));
  assert.ok(!JSON.stringify(coding).includes("image_url"));
  const original = (await host.session.context({ sessionID: session.id })).find((m) => m.type === "user");
  assert.ok(original.files?.some((file) => file.mime === "image/png" && file.data === image.split(",")[1]));
  assert.ok(!JSON.stringify(original).includes("Image description"));
  await prompt(session, "Later turn with the old image still in history.");
  assert.equal(requests.filter((body) => body.model === "fixture-vision").length, 1);
  assert.match((await host.session.generate({ sessionID: session.id, prompt: "Transient synthetic summary." })).text, /Synthetic coding response/);
  await host.session.compact({ sessionID: session.id });
  await wait(session);
  const compacted = (await host.message.list({ sessionID: session.id, type: "compaction" })).data;
  assert.ok(compacted.some((m) => m.type === "compaction" && m.status === "completed"));
  const archivedUsers = (await host.message.list({ sessionID: session.id, type: "user" })).data;
  assert.ok(archivedUsers.some((m) => m.files?.some((file) => file.data === image.split(",")[1])), "compaction must preserve original stored image data");
  assert.ok(hookCounts.compaction >= 1 && hookCounts.generate >= 1);

  const beforeBypass = requests.length;
  await prompt(await create("vision", "Disposable capability bypass"), "Receive the original image.", true);
  const bypass = requests.slice(beforeBypass);
  assert.equal(bypass.length, 1);
  assert.equal(bypass[0].model, "fixture-vision");
  assert.ok(JSON.stringify(bypass[0]).includes("image_url"));
  assert.ok(!JSON.stringify(bypass[0]).includes("Describe this image for a text-only coding assistant"));

  const beforeTool = requests.length;
  const toolSession = await create("text", "Disposable tool image");
  await prompt(toolSession, "USE_SYNTHETIC_TOOL");
  assert.equal((await host.session.get({ sessionID: toolSession.id })).outcome, "succeeded");
  const continuation = requests.slice(beforeTool).find((body) => body.model === "fixture-text" && body.messages.some((m) => m.role === "tool"));
  assert.ok(continuation && JSON.stringify(continuation).includes("A synthetic Save button."));
  assert.ok(!JSON.stringify(continuation).includes("image_url"));
  const toolHistory = await host.session.context({ sessionID: toolSession.id });
  const originalTool = toolHistory.flatMap((m) => m.type === "assistant" ? m.content : []).find((part) => part.type === "tool");
  assert.equal(originalTool.id, "fixture-tool-call");
  assert.equal(originalTool.state.status, "completed");
  assert.ok(originalTool.state.content.some((part) => part.type === "file" && part.uri === image));

  const untitled = await create("text");
  await prompt(untitled, "Synthetic image for title generation.", true);
  for (let attempt = 0; !hookCounts.title && attempt < 50; attempt++) await new Promise((done) => setTimeout(done, 100));
  assert.ok(hookCounts.title >= 1);

  failVision = true;
  const beforeFailure = requests.length;
  const failed = await create("text", "Disposable failure");
  await prompt(failed, "Synthetic failure must not forward the image.", true);
  assert.equal((await host.session.get({ sessionID: failed.id })).outcome, "failed");
  assert.ok(requests.slice(beforeFailure).every((body) => body.model === "fixture-vision"));
  const failedHistory = await host.session.context({ sessionID: failed.id });
  assert.ok(failedHistory.some((m) => m.type === "user" && m.files?.some((f) => f.data === image.split(",")[1])));
  assert.ok(requests.filter((body) => body.model === "fixture-text").every((body) => !JSON.stringify(body).includes("image_url")));
  console.log(JSON.stringify({ status: "passed", hookCounts, codingRequests: requests.filter((r) => r.model === "fixture-text").length, visionRequests: requests.filter((r) => r.model === "fixture-vision").length, blockedNonFixtureRequests }));
} finally {
  await host?.close();
  await new Promise((done) => server.close(done));
}
