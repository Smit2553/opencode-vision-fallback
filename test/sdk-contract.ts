// Compile against the actual released SDK, not invented ambient interfaces.
import { Provider, type Plugin } from "@opencode/plugin";
import type { ModelListOutput, ProviderGetOutput, ConnectionInfo } from "@opencode/client";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import { Media, Message } from "@opencode/ai";
import plugin from "../index.js";
import { createImageFallback } from "../fallback.js";
import { resolveConnection } from "../connection.js";

const definition: Plugin.Plugin = plugin;
const catalog: ModelListOutput = { location: { directory: "/synthetic" }, data: [] };
const provider: ProviderGetOutput = { location: { directory: "/synthetic" }, data: Provider.Info.empty(Provider.ID.make("fixture")) };
const key: ConnectionInfo = { type: "credential", id: "fixture", label: "Fixture", method: "key" };
const env: ConnectionInfo = { type: "env", name: "FIXTURE_KEY" };
const attachment: Message.Input = {
  role: "user", content: [{ type: "media", media: Media.fromDataUrl("data:image/png;base64,aA==") }],
};
const tool: Message.Input = {
  role: "tool", content: [{ type: "tool-result", id: "fixture", name: "read", result: {
    type: "content", value: [{ type: "file", uri: "data:image/png;base64,aA==", mime: "image/png" }],
  } }],
};
async function contracts(ctx: Plugin.Context, event: SessionRequest) {
  const result = await ctx.model.list();
  const model = result.data[0];
  await resolveConnection(ctx, model);
  await createImageFallback(ctx)(event);
}
void [definition, catalog, provider, key, env, attachment, tool, contracts];
