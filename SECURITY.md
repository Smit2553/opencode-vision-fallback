# Security

This plugin sends images to the configured vision provider and descriptions to
the selected coding provider. Use only providers approved for your data. Review
the README's authentication, privacy, and policy limitations before enabling it.

Images and descriptions are untrusted. Description labels and the vision prompt
are guidance, not a security sandbox. Do not let model output bypass your normal
tool permissions or approve destructive actions automatically.

Never include credentials, authorization headers, real image payloads, session
exports, or unredacted logs in a public issue. Reproduce with a synthetic image
and provide only versions, adapter name, sanitized options, and failure category.

For a vulnerability, use [GitHub private vulnerability reporting](https://github.com/Smit2553/opencode-vision-fallback/security/advisories/new)
on this repository rather than opening a public issue. Do not upload exploit
material containing private data or credentials.

CI runs with read-only permissions, SHA-pinned actions, and never receives real
provider credentials or executes the opt-in real-inference smoke helper.
