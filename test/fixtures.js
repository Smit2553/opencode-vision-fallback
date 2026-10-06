import { Model, Provider } from "@opencode/plugin";
import { Media } from "@opencode/ai";

// Synthetic one-pixel PNG. Never read user images, config, or session files.
export const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==";
export const file = { type: "file", mime: "image/png", uri: image, name: "fixture.png" };
export const media = { type: "media", media: Media.fromDataUrl(image) };

export function model(providerID, id, input = ["text"]) {
  return {
    ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id)),
    modelID: id,
    enabled: true,
    capabilities: { tools: true, input, output: ["text"] },
  };
}

export function harness({ generate, options = {}, credential, connection, provider: overrides = {}, vision: visionOverrides = {} } = {}) {
  const models = [
    model("coding", "text"),
    model("coding", "vision", ["text", "image"]),
    { ...model("fallback", "vision", ["text", "image"]),
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "https://vision.example.invalid/v1", apiKey: "fixture-key" },
      ...visionOverrides },
  ];
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("fallback")),
    activation: "enabled",
    package: "@opencode/ai/providers/openai-compatible",
    ...overrides,
  };
  const calls = [];
  const credentialCalls = [];
  const ctx = {
    options: { model: { providerID: "fallback", id: "vision" }, ...options },
    model: { list: async () => ({ location: { directory: "/synthetic" }, data: models }) },
    provider: { get: async () => ({ location: { directory: "/synthetic" }, data: provider }) },
    integration: { connection: {
      active: async (id) => { credentialCalls.push(["active", id]); return connection; },
      resolve: async (info) => { credentialCalls.push(["resolve", info]); return credential; },
    } },
  };
  return { ctx, models, provider, calls, credentialCalls, dependencies: {
    generate: async (...args) => {
      calls.push(args);
      return generate ? generate(...args) : "A button labeled Save.";
    },
  } };
}

export function event(content = [media], selected = { providerID: "coding", id: "text" }, sessionID = "session-fixture") {
  return { sessionID, model: selected, messages: [{ role: "user", content }], system: [], options: {} };
}
