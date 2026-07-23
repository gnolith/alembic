import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson, inspectLegacyBundle, sha256 } from "../src/index.js";
import { temporaryProject } from "./helpers.js";

test("legacy canonicalization sorts objects, preserves arrays, and normalizes NFC", () => {
  const composed = "é";
  const decomposed = "e\u0301";
  assert.equal(canonicalJson({ z: [2, 1], a: decomposed }), `{"a":"${composed}","z":[2,1]}`);
});

test("accepts only exact Setup 0.2.0 schema-v1 bundle bound to raw config", async () => {
  const root = await temporaryProject();
  const configPath = join(root, ".codex", "config.toml");
  await writeFile(configPath, "[mcp_servers.other]\nurl = \"https://other.example/mcp\"\n");
  const bytes = await readFile(configPath);
  const unsigned = {
    format: "gnolith-setup-to-alembic-v1" as const,
    schemaVersion: 1 as const,
    projectRoot: root,
    configDigest: sha256(bytes),
    legacyMarkerDigest: null,
    marker: {
      begin: "# BEGIN ALEMBIC MANAGED GNOLITH MCP" as const,
      end: "# END ALEMBIC MANAGED GNOLITH MCP" as const,
      state: "absent" as const
    },
    connection: {
      mode: "remote-http" as const,
      endpoint: "https://example.com/mcp",
      authentication: { kind: "oauth" as const }
    },
    receipts: []
  };
  const bundle = { ...unsigned, sha256: sha256(canonicalJson(unsigned)) };
  const encoded = Buffer.from(JSON.stringify(bundle));
  const inspected = await inspectLegacyBundle({
    bytes: encoded,
    packageName: "@gnolith/codex-plugin",
    packageVersion: "0.2.0",
    exactTaskRoot: root,
    configPath
  });
  assert.equal(inspected.disposition, "remote-verify");
  await assert.rejects(inspectLegacyBundle({
    bytes: encoded,
    packageName: "@gnolith/codex-plugin",
    packageVersion: "0.2.1",
    exactTaskRoot: root,
    configPath
  }), /Only @gnolith\/codex-plugin@0.2.0/u);
  const corrupt = Buffer.from(JSON.stringify({ ...bundle, unexpected: true }));
  await assert.rejects(inspectLegacyBundle({
    bytes: corrupt,
    packageName: "@gnolith/codex-plugin",
    packageVersion: "0.2.0",
    exactTaskRoot: root,
    configPath
  }), /exact schema keys/u);
});
