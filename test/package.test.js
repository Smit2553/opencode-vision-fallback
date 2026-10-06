import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release SDK pins cannot select a different peer patch or drift from the lockfile", async () => {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const version = metadata.dependencies["@opencode/ai"];
  assert.match(version, /^\d+\.\d+\.\d+$/, "native AI must use an exact version");
  assert.equal(metadata.peerDependencies["@opencode/plugin"], version, "a range can install an incompatible SDK patch");
  assert.equal(metadata.devDependencies["@opencode/plugin"], version);
  assert.equal(lock.packages[""].peerDependencies["@opencode/plugin"], version);
  assert.equal(lock.packages["node_modules/@opencode/plugin"].version, version);
  assert.equal(lock.packages["node_modules/@opencode/ai"].version, version);
});

test("package allowlist includes only runtime modules and documentation", async () => {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(metadata.files, [
    "index.js",
    "fallback.js",
    "connection.js",
    "vision.js",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "SECURITY.md",
  ]);
});


