/** @typedef {import('@opencode/plugin').Plugin.Context} Context */
/** @typedef {import('@opencode/client').ModelInfo} ModelInfo */

// These entrypoints implement API-key authentication; no user-supplied imports.
export const SUPPORTED_PACKAGES = new Set([
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/chat",
  "@opencode/ai/providers/openai/responses",
  "@opencode/ai/providers/openai-compatible",
  "@opencode/ai/providers/openai-compatible/responses",
  "@opencode/ai/providers/anthropic",
  "@opencode/ai/providers/anthropic-compatible",
  "@opencode/ai/providers/google",
  "@opencode/ai/providers/openrouter",
  "@opencode/ai/providers/xai",
]);

export class VisionConfigurationError extends Error {}

/**
 * Read OpenCode's resolved registry, never raw config or credential files.
 * Materialized Model.Info already includes provider defaults.
 * @param {Context} ctx
 * @param {ModelInfo} model
 */
export async function resolveConnection(ctx, model) {
  const response = await ctx.provider.get({ providerID: model.providerID });
  const provider = response.data;
  if (!provider || provider.id !== model.providerID || provider.activation === "disabled") {
    throw new VisionConfigurationError("Vision fallback provider is unavailable.");
  }
  const packageID = model.package ?? provider.package;
  if (!SUPPORTED_PACKAGES.has(packageID)) {
    throw new VisionConfigurationError("Vision fallback requires a supported native API-key provider package.");
  }
  // Clone before editing: neither registry nor provider configuration is changed.
  const settings = structuredClone(model.settings ?? provider.settings ?? {});
  const connection = await ctx.integration.connection.active(provider.integrationID ?? provider.id);
  if (connection) {
    const credential = await ctx.integration.connection.resolve(connection);
    if (!credential) throw new VisionConfigurationError("Vision fallback active credential could not be resolved.");
    if (credential.type === "oauth") {
      throw new VisionConfigurationError("Vision fallback does not support OAuth accounts; select an API-key vision provider.");
    }
    if (credential.type !== "key") throw new VisionConfigurationError("Vision fallback received an unexpected credential shape.");
    Object.assign(settings, credential.configuration, { apiKey: credential.key });
  }
  if (typeof settings.apiKey !== "string" || !settings.apiKey.trim()) {
    throw new VisionConfigurationError("Vision fallback requires an API key from OpenCode's active connection or resolved settings.");
  }
  const headers = structuredClone(model.headers ?? provider.headers ?? {});
  const body = structuredClone(model.body ?? provider.body ?? {});
  // Raw overlays must not replace the image, prompt, selected model, or tools policy.
  for (const key of ["model", "messages", "input", "contents", "system", "instructions", "tools", "tool_choice", "stream"]) {
    if (key in body) throw new VisionConfigurationError("Vision fallback refuses a raw body overlay that can replace its image request.");
  }
  if (settings.transport === "websocket") {
    throw new VisionConfigurationError("Vision fallback supports HTTP transport only; use a separate HTTP vision model/provider.");
  }
  // Server controls are not native adapter request options.
  for (const key of ["transport", "timeout", "headerTimeout", "chunkTimeout", "compaction"]) delete settings[key];
  return { packageID, modelID: model.modelID, compatibility: model.compatibility, settings: { ...settings, headers, body } };
}
