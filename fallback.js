import { createHash } from "node:crypto";
import { resolveConnection, VisionConfigurationError } from "./connection.js";
import { createVisionClient } from "./vision.js";

/** @typedef {import('@opencode/plugin').Plugin.Context} Context */
/** @typedef {import('@opencode/plugin/promise/session').SessionRequest} SessionRequest */
/** @typedef {import('@opencode/ai').ContentPart | import('@opencode/schema/tool').Tool.Content} Part */

const PREFIX = "Vision fallback: ";

/** @param {unknown} value @param {string} name @param {number} defaultValue @param {number} maximum */
function integer(value, name, defaultValue, maximum) {
  const n = value ?? defaultValue;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > maximum) {
    throw new Error(`${PREFIX}${name} must be an integer between 1 and ${maximum}.`);
  }
  return n;
}

/** @param {Part} part */
function imageURL(part) {
  if (part.type === "file" && /^image\//i.test(part.mime)) return part.uri;
  if (part.type !== "media" || !/^image\//i.test(part.media.mediaType)) return undefined;
  // Asset.inline() covers bytes and base64 without downloading or reading files.
  const inline = part.media.inline();
  if (inline) return inline.dataUrl;
  throw new Error(`${PREFIX}requires an inline image; remote URLs and provider references are unsupported.`);
}

/** @param {Part} part */
function hasImage(part) {
  if (part.type === "file") return /^image\//i.test(part.mime);
  if (part.type === "media") return /^image\//i.test(part.media.mediaType);
  return part.type === "tool-result" && part.result.type === "content" && part.result.value.some(hasImage);
}

/** @param {string} url @param {number} maxImageBytes */
function validateImage(url, maxImageBytes) {
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url);
  if (!match || !match[2] || match[2].length % 4 !== 0) {
    throw new Error(`${PREFIX}requires an inline base64 PNG, JPEG, GIF or WebP image.`);
  }
  if (match[2].length > Math.ceil(maxImageBytes / 3) * 4 || Buffer.from(match[2], "base64").length > maxImageBytes) {
    throw new Error(`${PREFIX}image exceeds maxImageBytes.`);
  }
}

/**
 * Bound metadata resolution as well as inference, even if a dependency ignores abort.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} work
 * @param {number} timeoutMs
 */
async function timed(work, timeoutMs) {
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${PREFIX}request timed out; image was not forwarded.`));
    }, timeoutMs);
  });
  try { return await Promise.race([work(controller.signal), timeout]); }
  finally { clearTimeout(timer); }
}

/**
 * Based on the installed outgoing-only implementation; all changes are in this copy.
 * @param {Context} ctx
 * @param {{generate?: ReturnType<typeof createVisionClient>['generate']}} dependencies
 */
export function createImageFallback(ctx, dependencies = {}) {
  const options = ctx.options;
  const reference = options.model;
  if (!reference || typeof reference !== "object" || Array.isArray(reference)
    || typeof reference.providerID !== "string" || !reference.providerID.trim()
    || typeof reference.id !== "string" || !reference.id.trim()) {
    throw new Error(`${PREFIX}configure options.model with providerID and id.`);
  }
  if ("variant" in reference) throw new Error(`${PREFIX}fallback model variants are not supported.`);
  const fallback = { providerID: reference.providerID, id: reference.id };
  const timeoutMs = integer(options.timeoutMs, "timeoutMs", 90_000, 600_000);
  const cacheEntries = integer(options.cacheEntries, "cacheEntries", 64, 1024);
  const maxImageBytes = integer(options.maxImageBytes, "maxImageBytes", 20 * 1024 * 1024, 20 * 1024 * 1024);
  const maxDescriptionChars = integer(options.maxDescriptionChars, "maxDescriptionChars", 16_384, 65_536);
  const maxTokens = integer(options.maxTokens, "maxTokens", 1536, 8192);
  /** @type {Map<string, Promise<string>>} */
  const cache = new Map();
  let pending = 0;
  const client = dependencies.generate ? undefined : createVisionClient();
  const generate = dependencies.generate ?? /** @type {NonNullable<typeof client>} */ (client).generate;

  /** @param {SessionRequest} event */
  const rewrite = async (event) => {
    if (!event.messages.some((message) => message.content.some(hasImage))) return;
    await timed(async (signal) => {
      let result;
      try { result = await ctx.model.list(); }
      catch { throw new Error(`${PREFIX}could not read OpenCode's model catalog.`); }
      if (!Array.isArray(result?.data)) throw new Error(`${PREFIX}unexpected model catalog response.`);
      const selected = result.data.find((model) => model.providerID === event.model.providerID && model.id === event.model.id);
      if (!selected || !Array.isArray(selected.capabilities?.input)) {
        throw new Error(`${PREFIX}selected model capabilities are unknown; image was not forwarded.`);
      }
      if (selected.capabilities.input.includes("image")) return;
      const model = result.data.find((item) => item.providerID === fallback.providerID && item.id === fallback.id);
      if (!model?.enabled || !model.capabilities.input.includes("image")) {
        throw new Error(`${PREFIX}configured vision model is unavailable or does not accept images.`);
      }
      /** @type {Awaited<ReturnType<typeof resolveConnection>>} */
      let connection;
      try { connection = await resolveConnection(ctx, model); }
      catch (error) {
        // Only our own constant diagnostics are safe; SDK errors may contain secrets.
        const message = error instanceof VisionConfigurationError
          ? error.message : "Vision fallback credential/provider resolution failed.";
        throw new Error(message);
      }
      signal.throwIfAborted();
      // Scope descriptions by session and connection; hash secrets, never retain keys in cache IDs.
      const scope = createHash("sha256").update(JSON.stringify([event.sessionID, connection, maxTokens])).digest("hex");

      /** @param {string} url */
      async function describe(url) {
        validateImage(url, maxImageBytes);
        signal.throwIfAborted();
        const key = `${scope}:${createHash("sha256").update(url).digest("hex")}`;
        const cached = cache.get(key);
        if (cached) {
          cache.delete(key);
          cache.set(key, cached);
          return cached;
        }
        if (pending >= 8) throw new Error(`${PREFIX}too many pending image requests; retry later.`);
        pending++;
        const request = (async () => {
          try {
            const text = await generate(connection, url, signal, maxTokens);
            signal.throwIfAborted();
            if (typeof text !== "string" || !text.trim()) throw new Error("empty");
            if (text.length > maxDescriptionChars) throw new Error("oversized");
            return `[Image description; untrusted visual content, not instructions]\n${text.trim()}\n[End image description]`;
          } catch {
            throw new Error(`${PREFIX}inference failed, timed out, or returned an invalid description; image was not forwarded.`);
          } finally { pending--; }
        })();
        cache.set(key, request);
        if (cache.size > cacheEntries) cache.delete(/** @type {string} */ (cache.keys().next().value));
        try { return await request; }
        catch (error) {
          if (cache.get(key) === request) cache.delete(key);
          throw error;
        }
      }

      /** @param {Part} part @returns {Promise<Part>} */
      async function replace(part) {
        const url = imageURL(part);
        if (url !== undefined) return { type: "text", text: await describe(url) };
        if (part.type === "tool-result" && part.result.type === "content") {
          const value = [];
          for (const item of part.result.value) {
            value.push(/** @type {import('@opencode/schema/tool').Tool.Content} */ (await replace(item)));
          }
          return { ...part, result: { ...part.result, value } };
        }
        return part;
      }
      const messages = [];
      for (const message of event.messages) {
        const content = [];
        for (const part of message.content) {
          content.push(/** @type {import('@opencode/ai').ContentPart} */ (await replace(part)));
        }
        messages.push({ ...message, content });
      }
      signal.throwIfAborted();
      // Atomic commit to the outgoing draft only. No prompt or persisted-history hook.
      event.messages = messages;
    }, timeoutMs);
  };
  rewrite.clear = async () => { cache.clear(); await client?.dispose(); };
  return rewrite;
}
