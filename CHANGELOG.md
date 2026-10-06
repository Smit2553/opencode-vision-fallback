# Changelog

## 0.1.0 — 2026-10-06

- OpenCode V2 outgoing-only image descriptions for text-only selected models;
  image-capable models bypass the fallback.
- Configurable vision provider/model with official native adapters and supported
  OpenCode credential resolution. No built-in model or endpoint defaults.
- User attachments, tool-returned images, old history, compaction, transient
  generation, and title hooks; original user/tool images remain unchanged.
- Bounded in-memory caching, concurrency and input/output limits, request
  deadlines, atomic rewrites, and sanitized explicit failures.
- SDK type checks, regression tests, disposable runtime smoke tests, and a
  real-provider validation using synthetic data.
- Exact, aligned OpenCode 2.0.24 SDK pins to prevent mixed-patch consumer runtime
  failures; lockfile/pin-coherence regression coverage.
- Installation, configuration, authentication limitations, privacy/cost/fidelity
  guidance, troubleshooting, security guidance, and MIT license.

Known limits: API-key fallback auth only; supported native HTTP adapters only;
inline PNG/JPEG/GIF/WebP inputs only; no fallback variants. Descriptions are
lossy and not a prompt-injection security boundary. Additional native inference
does not automatically inherit session hooks/retries/cost accounting. Real
inference has been validated on one OpenAI-compatible provider/model, not every
allowlisted adapter. OpenChamber's UI has not been exercised.
