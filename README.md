# opencode-vision-fallback

Let a **text-only OpenCode V2 coding model** use images through a separately
configured vision model. Images become labeled descriptions **only in outgoing
requests**. The original attachments and tool results remain in session history.
An image-capable selected model receives the original images without fallback.

This is **not a general provider-error fallback**. It does not switch coding
models on rate limits, outages, or authentication errors. A vision failure stops
the outgoing request explicitly: no image is silently removed or knowingly
forwarded to a text-only model.

## Status and requirements

- Initial public release (`0.1.0`). Install from a local clone of this repository
  (not yet published to npm).
- OpenCode **V2**, verified against official V2 docs and `@opencode/plugin`,
  `@opencode/client`, and `@opencode/ai` **2.0.24**. V1 plugins/API are incompatible.
- Node.js 22+ for development/tests; the plugin runs in OpenCode's server runtime.
- An enabled, correctly cataloged vision model on a supported **API-key** provider.
- The plugin peer/native SDK versions are pinned together. Do not mix OpenCode
  package patches inside one runtime; retest and update the pins together for a
  different SDK release.
- Wait until active sessions finish before changing live plugin configuration.

## Installation

Clone this repository to a directory **outside watched `.opencode/` or
global plugin directories**:

```sh
git clone https://github.com/Smit2553/opencode-vision-fallback.git
cd opencode-vision-fallback
npm ci --ignore-scripts
npm run check
```

Merge an entry into the `plugins` array of `opencode.json(c)`. Preserve
unrelated entries and settings. Use an absolute directory path; relative paths
resolve from the declaring config. Do not enable multiple vision-fallback
plugins in the same runtime.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-vision-fallback",
      "options": {
        "model": { "providerID": "vision-gateway", "id": "vision-alias" },
        "timeoutMs": 90000,
        "cacheEntries": 64,
        "maxImageBytes": 20971520,
        "maxTokens": 1536,
        "maxDescriptionChars": 16384
      }
    }
  ]
}
```

`options` are **this plugin's options**, not new OpenCode root configuration
fields. `model` is required; there is no default provider or model. Use the
OpenCode catalog ID (`id`), not the upstream deployment ID (`modelID`).
No model capability or provider configuration is rewritten by this plugin.

| Option | Default | Allowed |
| --- | --- | --- |
| `model` | required | `{ "providerID": "…", "id": "…" }`, no variants |
| `timeoutMs` | 90000 | integer 1–600000; total hook deadline, including metadata resolution |
| `cacheEntries` | 64 | integer 1–1024; bounded in-memory LRU entries |
| `maxImageBytes` | 20971520 | integer 1–20971520; decoded image bytes |
| `maxTokens` | 1536 | integer 1–8192; requested description output limit |
| `maxDescriptionChars` | 16384 | integer 1–65536; longer descriptions fail, not truncate |

Timeouts abort native inference. V2 request hooks do not expose a session abort
signal; session interruption is not independently wired into these descriptions.
At most eight inference calls can be pending per plugin instance; excess work
fails explicitly. Native/SDK errors and provider response bodies are not included
in plugin diagnostics.

## Configure the vision provider

You can use an existing API-key provider/model. The following **sanitized custom
provider example is a template**, not a working endpoint or model. Replace the
endpoint and upstream model ID, then verify actual image capability. Never mark
a text-only model as image-capable to bypass an error.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "vision-gateway": {
      "name": "Vision Gateway",
      "env": ["VISION_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://vision.example.com/v1" },
      "models": {
        "vision-alias": {
          "modelID": "YOUR_UPSTREAM_VISION_MODEL_ID",
          "capabilities": {
            "tools": false,
            "input": ["text", "image"],
            "output": ["text"]
          }
        }
      }
    }
  }
}
```

Use OpenCode's normal `/connect` API-key flow, or supply the named environment
variable to the **server process**, not just a UI shell. Native V2 also permits
`settings.apiKey: "{env:VISION_API_KEY}"`; do not commit literal keys. Ordinary
OpenCode configuration, JSONC parsing, substitutions, provider discovery, and
merging belong to OpenCode, not this plugin.

### Authentication and adapter limitations

The plugin reads the SDK's `{ location, data }` model/provider responses and uses
`ctx.integration.connection.active(integrationID)` and `.resolve(connection)`.
The provider's `integrationID` is used when present, otherwise its ID. Environment
connections are resolved through the same API, without guessing variable names.
An active key credential (`{ type: "key", key, configuration? }`) takes precedence
over configured `settings.apiKey`; its connection configuration is respected.
With no active connection, a resolved `settings.apiKey` is accepted. An active
but unresolvable connection fails rather than quietly using another account.

**OAuth is not supported for the fallback provider.** OpenCode supporting OAuth
for a coding provider does not imply its tokens can be used as generic API keys.
This plugin does not refresh, exchange, export, or reinterpret OAuth tokens or
read credential files. OAuth/subscription-only providers, command/ADC/SigV4 auth,
and anonymous endpoints are outside the supported fallback path. Use a separate
API-key vision provider. Your selected coding model can still use OAuth normally,
including bypassing this plugin when that model accepts images.

Supported native packages:

- `@opencode/ai/providers/openai`, `/openai/chat`, `/openai/responses`
- `@opencode/ai/providers/openai-compatible`, `/openai-compatible/responses`
- `@opencode/ai/providers/anthropic`, `/anthropic-compatible`
- `@opencode/ai/providers/google`, `/openrouter`, `/xai`

The official native adapter handles protocol format, endpoint paths, and auth
headers. Arbitrary package imports, `aisdk:` packages, Azure/Bedrock/Vertex,
Copilot-specific auth adapters, and WebSocket-only fallback connections are not
supported. Only the compatible-chat adapter has a full mocked wire-level smoke
test, disposable-runtime validation, and real inference validation on one
configured vision target. Other listed adapters use their official common
model contract and still need provider-specific live validation.

Materialized model settings, headers, body overlays, compatibility, and upstream
model IDs are preserved without changing their registry objects. OpenCode server
timeout/transport/compaction controls are not passed as adapter request options;
this plugin uses its own total timeout and HTTP client. Raw body overlays capable
of replacing the image request (`model`, `messages`, `input`, `contents`, `system`,
`instructions`, `tools`, `tool_choice`, `stream`) are rejected. Other configured
generation/body defaults can still affect descriptions and cost.

Vision inference uses a **separate native AI client**, not the session engine.
It does not create sessions, execute tools, or reenter session hooks. Other
plugins' session/HTTP hooks, server retries, policy enforcement beyond registry
availability, and session token/cost accounting do not automatically apply to
these extra calls. Use only providers approved for your data, and enforce any
required policy at the provider/network boundary.

## Attachments, tools, history, and OpenChamber

The same outgoing rewrite runs on `context`, `compaction`, `generate`, and
`title`. It examines the full assembled transcript, including old user images,
tool-driven continuations, decoded SDK `Media.Asset` objects, and tool results
with `{ type: "content", value: [{ type: "file", mime, uri }] }`. Tool call IDs
and non-image parts are preserved. There is no prompt-admission hook or durable
history write. Replacements commit only after the entire outgoing draft succeeds.

Supported inputs are inline base64/byte PNG, JPEG, GIF, and WebP images already
admitted by OpenCode. The plugin never downloads remote images, reads image files,
or resolves provider-specific image references. Unavailable old attachments,
remote URLs, unsupported MIME types, malformed encoding, and oversized images
fail explicitly. Animated/multi-frame content may be described only partially
by the provider. If a compacted checkpoint has already removed an image from
the assembled transcript, the plugin cannot recover it.

Descriptions for compaction are outgoing-only, but **OpenCode's normal compaction
summary may contain the description**, just as it may contain other model output.
Preserving the original history does not mean descriptions can never enter later
summaries or generated responses.

OpenChamber may supply a plugins-only `OPENCODE_CONFIG` overlay. This plugin never
treats that file as the entire provider configuration or parses it itself:
OpenCode's already-resolved registry is authoritative. Keep provider settings
in your normal configuration and put the **option-bearing plugin object** in the
managed plugin configuration. If the UI supports only package strings, keep the
options in a normal applicable config or use an external wrapper that supplies
them; there is no environment-based implicit fallback model. Avoid duplicate
entries or conflicting options in the effective setup.

This is compatible with OpenChamber versions using the **V2** server/plugin API;
it is not a compatibility shim for OpenChamber deployments still using V1.
OpenCode V2 configuration merging with a plugins-only overlay is validated in a
disposable SDK runtime test.

## Privacy, fidelity, and costs

- Every uncached image is sent to the configured vision provider. Its description
  is sent to the selected coding provider. Old-history images can cause calls
  on later turns, compaction, title generation, or transient requests.
- Images are **untrusted content**, including visible instructions. The vision
  prompt and description labels say so; this is not a prompt-injection security
  boundary. A description can repeat malicious text. Review sensitive output.
- Descriptions are **lossy**, may hallucinate, omit small text, or misunderstand
  layouts. They do not provide pixel coordinates or replace original-image
  reasoning. Inspect the original when correctness matters.
- The cache stores bounded descriptions/promises and hashed session/connection/
  image identities in memory, not disk. Raw payloads/credentials are transient
  during inference; neither is deliberately logged or persisted by this plugin.
  Descriptions themselves can contain sensitive information. OpenCode, provider,
  proxy, crash-dump, or other-plugin logging/retention is outside this guarantee.
- Cache scope includes the session and connection settings/credential, so other
  sessions/accounts do not reuse descriptions. Concurrent identical calls
  deduplicate; failed entries are removed, and eviction/unload/restart can lead
  to fresh calls. There is no cache TTL or persistent storage.
- Extra inference **costs money, tokens, latency, and rate-limit capacity**.
  Provider billing is authoritative; session cost totals may not include these
  native calls. Retries by the user or repeated failed requests can incur costs.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Plugin setup asks for a model | Use the V2 `plugins` object form with `options.model.providerID` and `id`. |
| Selected capabilities unknown | The selected model is absent from the SDK catalog; check provider activation and real capabilities. The plugin fails closed. |
| Vision model unavailable | Check the catalog ID, enabled state, and genuine `capabilities.input` image support. No automatic capability override is installed. |
| Missing/unresolved credential | Connect an API-key account or supply environment/config credentials to the server; check the active integration account. |
| OAuth unsupported | Choose a separate API-key vision provider; OAuth selected coding models are unaffected. |
| Native package/HTTP transport error | Use one of the supported native packages and an HTTP vision connection. |
| Inline/MIME/size error | Use an inline supported image through normal OpenCode attachment/tool admission. The plugin will not fetch private URLs. |
| Inference failure/invalid description | Check provider access, quota, true image support, output settings and limits; provider bodies are deliberately hidden. Retry only when safe. |
| Timeout | Check endpoint responsiveness and total transcript size; increase `timeoutMs` within its limit if appropriate. |
| Works outside OpenChamber | Check V2 compatibility and that the overlay retains the option-bearing plugin object, with no conflicting old plugin. |

Do not post credentials, image payloads, session exports, or unredacted provider
errors in issues. Record only version, adapter/package, sanitized option shape,
and reproduction with a synthetic image. Wait until active sessions finish
before restarting or reloading OpenCode or OpenChamber.

## Development and validation

```sh
npm ci --ignore-scripts
npm run check
```

Tests use synthetic images, fixture keys, mocked SDK responses, and mocked fetch
transport. They do not read live config/credentials/history, start a server,
attach to a service, or send real inference. GitHub Actions runs the same checks.

An additional **disposable V2 runtime smoke test** (`scripts/runtime-smoke.mjs`)
loads this plugin in an isolated embedded OpenCode V2 host with a loopback mock
provider and runs in CI against an installed npm tarball:

```sh
sdk_dir=$(mktemp -d)
npm install --prefix "$sdk_dir" --ignore-scripts --no-audit @opencode/sdk@2.0.24
node scripts/runtime-smoke.mjs "$sdk_dir"
```

## License

MIT. See [LICENSE](LICENSE).

