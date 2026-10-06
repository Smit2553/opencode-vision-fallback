// Opt-in: read an existing service catalog, then test real vision in a private host.
// Credentials/configuration cross only an in-memory IPC pipe, never a file or argv.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syntheticImage } from "./synthetic-image.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
function check(condition, code) { if (!condition) throw new Error(code); }
const CHECKS = ["vision", "test", "42", "save", "red", "blue"];

async function parent() {
  const [sdkPath, providerID, id] = process.argv.slice(2);
  check(sdkPath && providerID && id, "usage: node scripts/real-smoke.mjs SDK_DIRECTORY PROVIDER_ID MODEL_ID");
  const sdkDirectory = resolve(sdkPath);
  const metadata = JSON.parse(await readFile(join(sdkDirectory, "node_modules/@opencode/sdk/package.json"), "utf8"));
  check(metadata.version === "2.0.24", "sdk-version");
  const { Service } = await import("@opencode/client/service");
  const { OpenCode } = await import("@opencode/client");
  const endpoint = await Service.discover({ version: (version) => version.startsWith("2.") });
  check(endpoint, "existing-v2-service-required-no-service-will-be-started");
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const options = { signal: AbortSignal.timeout(15000) };
  const models = await client.model.list(undefined, options);
  const model = models.data.find((item) => item.providerID === providerID && item.id === id);
  check(model?.enabled && model.capabilities.input.includes("image"), "enabled-image-model-required");
  const provider = (await client.provider.get({ providerID }, options)).data;
  // This smoke helper deliberately supports resolved setting keys only; the plugin
  // itself also supports active key/environment connections (covered separately).
  check(typeof model.settings?.apiKey === "string" && model.settings.apiKey, "resolved-settings-key-required");
  check(typeof model.settings.baseURL === "string", "resolved-base-url-required");
  const origin = new URL(model.settings.baseURL).origin;
  check(origin.startsWith("https://"), "https-provider-required");
  await mkdir("/tmp/opencode", { recursive: true });
  const root = await mkdtemp("/tmp/opencode/vision-fallback-real-");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", sdkDirectory], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), TMPDIR: join(root, "tmp") },
    stdio: ["pipe", "inherit", "inherit"],
  });
  const timeout = setTimeout(() => child.kill(), 240000);
  const finished = new Promise((done, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => done(code ?? 1));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ model, provider, origin }));
  try { process.exitCode = await finished; }
  finally { clearTimeout(timeout); }
}

async function child() {
  const root = process.cwd();
  check(root.startsWith("/tmp/opencode/vision-fallback-real-") && process.env.HOME === join(root, "home"), "isolation");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { model, provider, origin } = JSON.parse(Buffer.concat(chunks).toString());
  for (const directory of ["home", "config", "data", "cache", "state", "tmp", "project"]) await mkdir(join(root, directory), { recursive: true });
  const image = syntheticImage();
  let realRequests = 0;
  let codingRequests = 0;
  let blockedRequests = 0;
  let providerFailure;
  const matched = new Set();
  const kinds = new Set();
  let toolCalled = false;
  let fixtureOrigin;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== origin && url.origin !== fixtureOrigin) { blockedRequests++; throw new Error("network-origin-blocked"); }
    if (url.origin === origin) realRequests++;
    const response = await fetch(input, { ...init, redirect: "error" });
    if (url.origin === origin && !response.ok) providerFailure = response.status;
    return response;
  };
  function sse(response, content, tool = false) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "synthetic-tool-call", type: "function", function: { name: "synthetic_image", arguments: "{}" } }] } : { role: "assistant", content };
    response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }
  const server = createServer(async (request, response) => {
    try {
      const parts = [];
      for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      codingRequests++;
      const serialized = JSON.stringify(body.messages);
      check(!serialized.includes("image_url") && !serialized.includes("data:image/"), "image-forwarded-to-text-model");
      // Check only returned descriptions, not user/system prompts that could
      // coincidentally contain the expected words.
      const texts = body.messages.flatMap((message) => typeof message.content === "string"
        ? [message.content] : (message.content ?? []).map((part) => part.text ?? ""));
      for (const text of texts) {
        for (const description of text.matchAll(/\[Image description;[^\]]*\]\n([\s\S]*?)\n\[End image description\]/g)) {
          for (const word of CHECKS) if (description[1].toLowerCase().includes(word)) matched.add(word);
        }
      }
      if (serialized.includes("USE_REAL_TEST_TOOL") && !toolCalled) { toolCalled = true; sse(response, "", true); return; }
      const summary = "## Objective\n- Complete synthetic validation.\n\n## Next Move\n1. Finish validation.";
      sse(response, serialized.includes("<template>") ? summary : "Synthetic coding response.");
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "synthetic-coding-request-validation-failed" } }));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
  let host;
  try {
    const { OpenCode } = await import(pathToFileURL(join(process.argv[3], "node_modules/@opencode/sdk/dist/index.js")));
    const { Model, Provider } = await import("@opencode/plugin");
    const fallback = (await import("../index.js")).default;
    host = await OpenCode.create({
      config: { directory: join(root, "config"), project: false, content: JSON.stringify({ snapshots: false,
        model: "synthetic/text", agents: { title: { model: "synthetic/text" } }, compaction: { auto: false, keep: { tokens: 0 } },
        permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "synthetic_image", resource: "*", effect: "allow" }] }) },
      database: { path: ":memory:" }, models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false }, log: { level: "error", emit: () => {} },
      plugins: [
        { id: "real-smoke.source", async setup(ctx) {
          await ctx.provider.transform((editor) => {
            // Private, in-memory registry only; no real credentials/config are written.
            editor.add({ info: { ...provider, activation: "enabled", integrationID: undefined }, models: [model] });
            editor.add({ info: { ...Provider.Info.empty(Provider.ID.make("synthetic")), activation: "enabled",
              package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${fixtureOrigin}/v1`, apiKey: "synthetic-key" } },
              models: [{ ...Model.Info.default(Provider.ID.make("synthetic"), Model.ID.make("text")), enabled: true,
                capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 100000, output: 2000 } }] });
          });
          await ctx.tool.transform((editor) => editor.add({ name: "synthetic_image", description: "Return an in-memory synthetic image.",
            input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
            async execute() { return { content: [{ type: "file", uri: image, mime: "image/png" }] }; } }));
        } },
        { id: fallback.id, setup: (ctx) => fallback.setup({ ...ctx, options: { model: { providerID: model.providerID, id: model.id }, maxTokens: 768, timeoutMs: 90000 } }) },
        { id: "real-smoke.audit", async setup(ctx) {
          for (const kind of ["context", "compaction", "generate", "title"]) await ctx.session.hook(kind, () => { kinds.add(kind); });
        } },
      ],
    });
    const make = (title, reference = { providerID: "synthetic", id: "text" }) => host.session.create({ title, location: { directory: join(root, "project") }, model: reference });
    const wait = async (session) => {
      await host.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(120000) });
      check((await host.session.get({ sessionID: session.id })).outcome === "succeeded", providerFailure ? `vision-http-${providerFailure}` : "private-session-failed");
    };
    const first = await make("Synthetic real-provider smoke");
    await host.session.prompt({ sessionID: first.id, text: "Describe the synthetic image.", files: [{ uri: image, name: "synthetic.png" }] });
    await wait(first);
    check(CHECKS.every((word) => matched.has(word)), "synthetic-image-content-not-recognized");
    const history = await host.session.context({ sessionID: first.id });
    check(history.some((message) => message.type === "user" && message.files?.some((file) => file.data === image.split(",")[1])), "user-image-history-changed");
    const afterFirst = realRequests;
    await host.session.prompt({ sessionID: first.id, text: "Continue using the original image in history." });
    await wait(first);
    await host.session.generate({ sessionID: first.id, prompt: "Summarize the synthetic exchange." });
    await host.session.compact({ sessionID: first.id });
    await host.session.wait({ sessionID: first.id }, { signal: AbortSignal.timeout(120000) });
    check((await host.message.list({ sessionID: first.id, type: "compaction" })).data.some((message) => message.status === "completed"), "compaction-failed");
    check(realRequests === afterFirst, "continuation-cache-not-reused");
    const tools = await make("Synthetic real-provider tool image");
    await host.session.prompt({ sessionID: tools.id, text: "USE_REAL_TEST_TOOL" });
    await wait(tools);
    const toolHistory = await host.session.context({ sessionID: tools.id });
    check(toolHistory.some((message) => message.type === "assistant" && message.content.some((part) => part.type === "tool" && part.state.status === "completed" && part.state.content.some((item) => item.type === "file" && item.uri === image))), "tool-image-history-changed");
    const untitled = await make();
    await host.session.prompt({ sessionID: untitled.id, text: "Synthetic title test.", files: [{ uri: image }] });
    await wait(untitled);
    for (let attempt = 0; !kinds.has("title") && attempt < 100; attempt++) await new Promise((done) => setTimeout(done, 100));
    check(kinds.has("title"), "title-hook-not-exercised");
    const beforeBypass = realRequests;
    const capable = await make("Synthetic native-image bypass", { providerID: model.providerID, id: model.id });
    await host.session.prompt({ sessionID: capable.id, text: "Describe the red shape and the blue control in this synthetic image. Do not use tools.", files: [{ uri: image }] });
    await wait(capable);
    check(realRequests === beforeBypass + 1, "image-capability-bypass-not-direct");
    check(["context", "compaction", "generate", "title"].every((kind) => kinds.has(kind)), "request-hook-missing");
    console.log(JSON.stringify({ status: "passed", realVisionRequests: realRequests, syntheticCodingRequests: codingRequests,
      recognitionChecks: CHECKS.length, hooks: [...kinds].sort(), blockedNonApprovedRequests: blockedRequests,
      originalUserAndToolImagesPreserved: true, continuationCacheReused: true, nativeImageBypass: true }));
  } finally {
    await host?.close();
    await new Promise((done) => server.close(done));
  }
}

try { await (process.argv[2] === "--child" ? child() : parent()); }
catch (error) {
  const known = /^(usage:|sdk-version$|existing-v2-service-required|enabled-image-model-required|resolved-settings-key-required|resolved-base-url-required|https-provider-required|isolation$|vision-http-\d+$|private-session-failed$|synthetic-image-content-not-recognized$|user-image-history-changed$|compaction-failed$|continuation-cache-not-reused$|tool-image-history-changed$|title-hook-not-exercised$|image-capability-bypass-not-direct$|request-hook-missing$)/;
  console.log(JSON.stringify({ status: "failed", reason: error instanceof Error && known.test(error.message) ? error.message : "real-smoke-failed-details-suppressed" }));
  process.exitCode = 1;
}
