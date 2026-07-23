import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  BEGIN_MARKER,
  END_MARKER,
  inspectConfigText,
  renderManagedBlock,
  replaceManagedBlock,
  attestProject,
  approveEndpoint,
  TOOL_CATALOG,
  TOOL_NAMES
} from "../src/index.js";
import { temporaryProject } from "./helpers.js";

test("fixed catalog contains only nine bounded Alembic operations", () => {
  assert.deepEqual(TOOL_CATALOG.map(({ name }) => name), [...TOOL_NAMES]);
  assert.equal(TOOL_CATALOG.length, 9);
  assert.equal(TOOL_CATALOG.some(({ name }) => /gnolith|search|knowledge|query/u.test(name)), false);
  assert.equal(TOOL_CATALOG.every(({ inputSchema }) => inputSchema.additionalProperties === false), true);
});

test("exact local block has mutually exclusive selector and URL-only shape", () => {
  const bearer = renderManagedBlock("http://127.0.0.1/mcp", {
    kind: "environment",
    variable: "GNOLITH_BEARER_TOKEN"
  });
  assert.equal(bearer, [
    BEGIN_MARKER,
    "[mcp_servers.gnolith]",
    'url = "http://127.0.0.1/mcp"',
    'bearer_token_env_var = "GNOLITH_BEARER_TOKEN"',
    "required = false",
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
    'default_tools_approval_mode = "writes"',
    END_MARKER
  ].join("\n"));
  assert.doesNotMatch(bearer, /command|args|cwd|stdio|docker|token_file|auth =/u);
  const oauth = renderManagedBlock("https://example.com/mcp", {
    kind: "host-oauth",
    profile: "remote-oauth-v1",
    issuer: "https://issuer.example",
    audience: "gnolith",
    scopes: ["mcp"]
  });
  assert.match(oauth, /^auth = "oauth"$/mu);
  assert.doesNotMatch(oauth, /bearer_token_env_var/u);
});

test("config replacement preserves unrelated content and rejects user ownership", () => {
  const existing = "[mcp_servers.other]\nurl = \"https://other.example/mcp\"\n";
  const block = renderManagedBlock("https://example.com/mcp", {
    kind: "host-oauth",
    profile: "remote-oauth-v1",
    issuer: "https://issuer.example",
    audience: "gnolith",
    scopes: ["mcp"]
  });
  const result = replaceManagedBlock(existing, block, "upsert");
  assert.match(result, /\[mcp_servers\.other\]/u);
  assert.equal(inspectConfigText(result).state, "complete");
  assert.throws(() => replaceManagedBlock("[mcp_servers.gnolith]\nurl=\"x\"\n", block, "upsert"),
    /user-owned/u);
  assert.equal(inspectConfigText(`${BEGIN_MARKER}\n${END_MARKER}\n${END_MARKER}`).state, "invalid");
});

test("attestation fails closed without metadata or exact confirmation", async () => {
  const root = await temporaryProject();
  await assert.rejects(attestProject({ taskDirectory: root }), /confirmation/u);
  const attested = await attestProject({ taskDirectory: root, confirmedProjectRoot: root });
  assert.equal(attested.root, root);
  await writeFile(join(root, ".codex", "config.toml"), "[mcp_servers.other]\n");
  const nested = join(root, "nested");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(nested));
  const nestedAttested = await attestProject({ taskDirectory: nested, confirmedProjectRoot: root });
  assert.equal(nestedAttested.root, root);
});

test("host trust, policy, scope spoofing, traversal, and nested precedence fail closed", async () => {
  const root = await temporaryProject();
  const nested = join(root, "nested");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(nested, ".codex"), { recursive: true }));
  await writeFile(join(nested, ".codex", "config.toml"), "[mcp_servers.other]\n");
  await assert.rejects(attestProject({ taskDirectory: nested, confirmedProjectRoot: root }), /nearest-config/u);
  await assert.rejects(attestProject({
    taskDirectory: root,
    hostMetadata: { version: 1, taskDirectory: root, projectRoot: root, trusted: false, managedPolicy: "allow" }
  }), /trust/u);
  await assert.rejects(attestProject({
    taskDirectory: root,
    hostMetadata: { version: 1, taskDirectory: root, projectRoot: root, trusted: true, managedPolicy: "deny" }
  }), /policy/u);
  await assert.rejects(attestProject({ taskDirectory: `${root}${process.platform === "win32" ? "\\..\\" : "/../"}`, confirmedProjectRoot: root }),
    /normalized|directory/u);
});

test("endpoint policy denies cleartext remote, credential URL, and private remote", async () => {
  await assert.rejects(approveEndpoint("http://example.com/mcp", "remote"), /HTTPS/u);
  await assert.rejects(approveEndpoint("https://user:password@example.com/mcp", "remote"), /Credentials/u);
  await assert.rejects(approveEndpoint("https://127.0.0.1/mcp", "remote"), /privately|public/u);
  await assert.rejects(approveEndpoint("https://example.com/health", "remote"), /\/mcp/u);
});
