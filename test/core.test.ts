import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  BEGIN_MARKER,
  END_MARKER,
  inspectConfigText,
  renderManagedBlock,
  replaceManagedBlock,
  attestProject,
  approveEndpoint,
  TOOL_CATALOG,
  TOOL_NAMES,
  SEEDBED_LOCAL_BUILD_TRUST,
  WORKSHOP_CATALOG_DIGEST,
  WORKSHOP_MIGRATION_SCHEMA_VERSION,
  WORKSHOP_OPERATION_SCHEMA_VERSION,
  WORKSHOP_TOOL_NAMES,
  canonicalBaseIri,
  canonicalBearerSecret
} from "../src/index.js";
import { runIsolatedTool } from "../src/tool-isolation.js";
import { boundedSeedbedCall } from "../src/seedbed-call.js";
import { temporaryProject } from "./helpers.js";

test("fixed catalog contains only nine bounded Alembic operations", () => {
  assert.deepEqual(TOOL_CATALOG.map(({ name }) => name), [...TOOL_NAMES]);
  assert.equal(TOOL_CATALOG.length, 9);
  assert.equal(TOOL_CATALOG.some(({ name }) => /gnolith|search|knowledge|query/u.test(name)), false);
  assert.equal(TOOL_CATALOG.every(({ inputSchema }) => inputSchema.additionalProperties === false), true);
});

test("base identities and protected bearer text use one canonical spelling", () => {
  assert.equal(canonicalBaseIri("HTTPS://EXAMPLE.TEST/base/"), "https://example.test/base");
  assert.equal(canonicalBaseIri("https://example.test/base"), "https://example.test/base");
  assert.equal(canonicalBearerSecret(Buffer.from("canonical_token_123\n")), "canonical_token_123");
  assert.equal(canonicalBearerSecret(Buffer.from("canonical_token_123")), "canonical_token_123");
  for (const invalid of [
    "canonical_token_123\n\n",
    "canonical_token_123\r\n",
    " canonical_token_123\n",
    "canonical_token_123 \n",
    "canonical_token_123\u0000\n"
  ]) {
    assert.throws(() => canonicalBearerSecret(Buffer.from(invalid)), /canonical text secret/u);
  }
});

test("isolated MCP tools retain a hard deadline when a dependency blocks", async () => {
  const startedAt = Date.now();
  for (const operation of ["plan", "legacy-inspect"] as const) {
    await assert.rejects(
      runIsolatedTool(operation, {}, {
        deadlineMs: 50,
        workerUrl: new URL("./hanging-worker.js", import.meta.url)
      }),
      (error) => {
        assert.equal((error as { code?: string }).code, `${operation}-timeout`);
        assert.deepEqual((error as { details?: unknown }).details, {
          operation,
          stage: "worker-start",
          retryable: true
        });
        return true;
      }
    );
  }
  assert.equal(Date.now() - startedAt < 1_000, true);
});

test("SeedbedControl rejections retain only bounded code and phase evidence", async () => {
  await assert.rejects(
    boundedSeedbedCall("plan", 100, async () => {
      throw new TypeError("Expected Workshop versions or catalog do not match immutable Seedbed policy");
    }),
    (error) => {
      assert.equal((error as { code?: string }).code, "seedbed-control-rejected");
      assert.deepEqual((error as { details?: unknown }).details, {
        operation: "plan",
        phase: "seedbed-plan",
        upstream: {
          code: "seedbed-request-compatibility",
          phase: "plan"
        },
        retryable: false
      });
      assert.doesNotMatch(JSON.stringify(error), /versions or catalog/u);
      return true;
    }
  );
});

test("runtime Workshop verification exactly matches the final public candidate lock", async () => {
  const lock = JSON.parse(await readFile(join(process.cwd(), "candidate-lock.json"), "utf8")) as {
    workshop: {
      commit: string;
      sha256: string;
      migrationSchema: number;
      operationSchema: number;
      catalogSize: number;
      catalogDigest: string;
      containerWorkdir: string;
    };
  };
  assert.equal(lock.workshop.commit, "10ce0e1ae441094b28e61ad2772e10e1b391a464");
  assert.equal(lock.workshop.sha256, "6479db87d6c2529b4a5c9e5063cc705f8f2aa3057ae4c7d5a0668e36e48163e4");
  assert.equal(lock.workshop.migrationSchema, WORKSHOP_MIGRATION_SCHEMA_VERSION);
  assert.equal(lock.workshop.operationSchema, WORKSHOP_OPERATION_SCHEMA_VERSION);
  assert.equal(lock.workshop.catalogSize, WORKSHOP_TOOL_NAMES.length);
  assert.equal(lock.workshop.catalogDigest, WORKSHOP_CATALOG_DIGEST);
  assert.equal(lock.workshop.containerWorkdir, "/app");
  assert.equal(WORKSHOP_TOOL_NAMES.length, 52);
  assert.equal(new Set(WORKSHOP_TOOL_NAMES).size, 52);
  assert.equal(WORKSHOP_TOOL_NAMES.includes("authorization_admin"), true);
});

test("runtime Seedbed local-build trust exactly matches the public candidate lock", async () => {
  const lock = JSON.parse(await readFile(join(process.cwd(), "candidate-lock.json"), "utf8")) as {
    seedbed: {
      sha256: string;
      localBuild: {
        kind: string;
        selector: string;
        pullPolicy: string;
        componentLockSha256: string;
        graphSha256: string;
        composeBundleSha256: string;
      };
    };
  };
  assert.deepEqual(SEEDBED_LOCAL_BUILD_TRUST, {
    format: "gnolith-alembic-seedbed-local-build-trust-v1",
    seedbedCandidateSha256: lock.seedbed.sha256,
    localBuild: lock.seedbed.localBuild
  });
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
  assert.equal(inspectConfigText(block.replace("[mcp_servers.gnolith]", "[mcp_servers.gnolith]\ncommand = \"malicious\"")).state, "invalid");
  assert.equal(inspectConfigText(block.replace("https://example.com", "https://user:secret@example.com")).state, "invalid");
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

test("symlink or junction config parents are rejected", async () => {
  const root = await temporaryProject();
  const external = await temporaryProject();
  const { rm, symlink } = await import("node:fs/promises");
  await rm(join(root, ".codex"), { recursive: true });
  await symlink(join(external, ".codex"), join(root, ".codex"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    attestProject({ taskDirectory: root, confirmedProjectRoot: root }),
    /unsafe|alias/u
  );
});

test("endpoint policy denies cleartext remote, credential URL, and private remote", async () => {
  await assert.rejects(approveEndpoint("http://example.com/mcp", "remote"), /HTTPS/u);
  await assert.rejects(approveEndpoint("https://user:password@example.com/mcp", "remote"), /Credentials/u);
  await assert.rejects(approveEndpoint("https://127.0.0.1/mcp", "remote"), /privately|public/u);
  await assert.rejects(approveEndpoint("https://example.com/health", "remote"), /\/mcp/u);
});
