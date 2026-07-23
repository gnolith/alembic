import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { applyPlan, canonicalJson, createPlan, inspectConfig, resumeOperation, sha256, verifyPlan } from "../src/index.js";
import { MockSeedbed, MockWorkshop, expectedStatus, protectedToken, temporaryProject } from "./helpers.js";

test("Docker-local apply invokes Seedbed, verifies protocol, writes config last, and requires new task", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: "ghcr.io/gnolith/workshop@sha256:" + "b".repeat(64),
    expected: expectedStatus
  };
  const plan = await createPlan({
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "create",
    mode: "docker-local",
    endpoint: docker.endpoint,
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected: expectedStatus,
    docker
  }, seedbed);
  const receipt = await applyPlan(plan, { seedbed, workshopTransport: new MockWorkshop() });
  assert.equal(receipt.state, "activation-required");
  assert.match(receipt.message, /Start one new Codex task/u);
  assert.equal(seedbed.applied, 1);
  const config = await readFile(join(root, ".codex", "config.toml"), "utf8");
  assert.match(config, /bearer_token_env_var = "GNOLITH_BEARER_TOKEN"/u);
  assert.doesNotMatch(config, new RegExp(protectedCredential.token, "u"));
  assert.equal(receipt.checkpoints.at(-1)?.step, "config-write");
  assert.equal(receipt.checkpoints.at(-1)?.phase, "after");
});

test("credential mismatch stops before config mutation with activation prerequisite", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = "wrong_canary_value";
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: "ghcr.io/gnolith/workshop@sha256:" + "b".repeat(64),
    expected: expectedStatus
  };
  const plan = await createPlan({
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "create",
    mode: "docker-local",
    endpoint: docker.endpoint,
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected: expectedStatus,
    docker
  }, seedbed);
  await assert.rejects(applyPlan(plan, { seedbed, workshopTransport: new MockWorkshop() }), /Inject the protected credential/u);
  assert.equal((await inspectConfig(join(root, ".codex", "config.toml"))).digest, null);
});

test("activation prerequisite resumes the exact operation idempotently", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: "ghcr.io/gnolith/workshop@sha256:" + "b".repeat(64),
    expected: expectedStatus
  };
  const plan = await createPlan({
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "create",
    mode: "docker-local",
    endpoint: docker.endpoint,
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected: expectedStatus,
    docker
  }, seedbed);
  process.env.GNOLITH_BEARER_TOKEN = "wrong";
  await assert.rejects(applyPlan(plan, { seedbed, workshopTransport: new MockWorkshop() }), /Inject/u);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const resumed = await resumeOperation(root, plan.operationId, { seedbed, workshopTransport: new MockWorkshop() });
  assert.equal(resumed.operationId, plan.operationId);
  assert.equal(resumed.state, "activation-required");
  assert.equal(seedbed.applied, 1);
  assert.equal(seedbed.resumed, 1);
  const repeated = await applyPlan(plan, { seedbed, workshopTransport: new MockWorkshop() });
  assert.deepEqual(repeated, resumed);
});

test("concurrent config change invalidates a bound plan before Seedbed mutation", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: "ghcr.io/gnolith/workshop@sha256:" + "b".repeat(64),
    expected: expectedStatus
  };
  const plan = await createPlan({
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "create",
    mode: "docker-local",
    endpoint: docker.endpoint,
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected: expectedStatus,
    docker
  }, seedbed);
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(join(root, ".codex", "config.toml"), "[mcp_servers.other]\nurl=\"https://changed.example/mcp\"\n")
  );
  await assert.rejects(applyPlan(plan, { seedbed, workshopTransport: new MockWorkshop() }), /Config digest changed/u);
  assert.equal(seedbed.applied, 0);
});

test("expired or modified plans fail before external mutation", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: "ghcr.io/gnolith/workshop@sha256:" + "b".repeat(64),
    expected: expectedStatus
  };
  const plan = await createPlan({
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "create",
    mode: "docker-local",
    endpoint: docker.endpoint,
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected: expectedStatus,
    docker
  }, seedbed);
  assert.throws(() => verifyPlan({ ...plan, endpoint: "http://127.0.0.1:9999/mcp" }), /digest/u);
  const { digest: oldDigest, ...unsigned } = { ...plan, expiresAt: "2000-01-01T00:00:00.000Z" };
  assert.equal(oldDigest, plan.digest);
  const expired = { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
  assert.throws(() => verifyPlan(expired), /expired/u);
  assert.equal(seedbed.applied, 0);
});

test("remote OAuth validates metadata, uses host token transiently, and writes auth only", async () => {
  const root = await temporaryProject();
  let authorized = 0;
  let tokenObserved = false;
  const oauthHost = {
    async discover(endpoint: URL) {
      return {
        resource: endpoint.href,
        authorizationServers: ["https://issuer.example"],
        issuer: "https://issuer.example",
        audience: "gnolith",
        scopes: ["mcp:use"],
        algorithms: ["ES256"]
      };
    },
    async authorize() {
      authorized += 1;
      return { descriptorId: "host-descriptor" };
    },
    async accessToken() {
      return "REMOTE_OAUTH_SECRET_CANARY_9sK";
    }
  };
  const transport = new MockWorkshop();
  const observingTransport = {
    async call(endpoint: URL, token: string, method: string, params: unknown, sessionId?: string) {
      tokenObserved ||= token === "REMOTE_OAUTH_SECRET_CANARY_9sK";
      return transport.call(endpoint, token, method, params, sessionId);
    }
  };
  const plan = await createPlan({
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "connect",
    mode: "remote",
    endpoint: "https://example.com/mcp",
    authentication: {
      kind: "host-oauth",
      profile: "remote-oauth-v1",
      issuer: "https://issuer.example",
      audience: "gnolith",
      scopes: ["mcp:use"]
    },
    expected: expectedStatus
  });
  const receipt = await applyPlan(plan, { oauthHost, workshopTransport: observingTransport });
  assert.equal(receipt.state, "activation-required");
  assert.equal(authorized, 1);
  assert.equal(tokenObserved, true);
  const serialized = JSON.stringify(receipt) + await readFile(join(root, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(serialized, /REMOTE_OAUTH_SECRET_CANARY_9sK/u);
  assert.match(serialized, /auth = "oauth"/u);
  assert.doesNotMatch(serialized, /bearer_token_env_var/u);
});

test("successful Seedbed legacy-local-v1 receipt is consumed before activation", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const evidence = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    domainCount: 42,
    payloadDigest: "d".repeat(64),
    catalogDigest: expectedStatus.catalogDigest,
    ownerLedgerDigest: "e".repeat(64)
  };
  const plan = await createPlan({
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "adopt",
    mode: "docker-local",
    endpoint: "http://127.0.0.1/mcp",
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected: expectedStatus,
    legacyHandoff: { bundleDigest: "f".repeat(64), operationIds: ["legacy-op"] },
    legacyEvidence: evidence,
    legacyAdoption: {
      format: "gnolith-seedbed-legacy-adoption-v1",
      version: "0.1.0",
      operationId: "seedbed-adopt-op",
      state: "ready",
      ...evidence,
      protectedTokenFile: {
        kind: "protected-file",
        canonicalPath: protectedCredential.path,
        credentialId: "legacy-credential",
        sha256: protectedCredential.digest
      }
    }
  });
  const receipt = await applyPlan(plan, { workshopTransport: new MockWorkshop() });
  assert.equal(receipt.state, "activation-required");
  assert.equal(receipt.seedbed?.operationId, "seedbed-adopt-op");
  const adoption = JSON.parse(
    await readFile(join(root, ".codex", "alembic", "adoptions", `${plan.operationId}.json`), "utf8")
  ) as { reversible: boolean; originalBundleDigest: string; legacyPackage: string };
  assert.equal(adoption.reversible, true);
  assert.equal(adoption.originalBundleDigest, "f".repeat(64));
  assert.equal(adoption.legacyPackage, "@gnolith/codex-plugin@0.2.0");
});

test("wrong identity, shallow catalog, and degraded semantics cannot verify", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const common = {
    endpoint: "http://127.0.0.1/mcp",
    mode: "docker-local" as const,
    authentication: { kind: "environment" as const, variable: "GNOLITH_BEARER_TOKEN" as const },
    expected: expectedStatus,
    protectedFile: { kind: "protected-file" as const, canonicalPath: protectedCredential.path, credentialId: "test", sha256: protectedCredential.digest }
  };
  const { verifyWorkshop } = await import("../src/workshop.js");
  await assert.rejects(verifyWorkshop({ ...common, transport: new MockWorkshop(expectedStatus, "not-gnolith") }), /identity/u);
  await assert.rejects(verifyWorkshop({ ...common, transport: new MockWorkshop(expectedStatus, "gnolith", ["health"]) }), /gnolith_status/u);
  await assert.rejects(verifyWorkshop({
    ...common,
    expected: { ...expectedStatus, semanticState: "degraded", allowLexicalOnly: false },
    transport: new MockWorkshop({ ...expectedStatus, semanticState: "degraded" })
  }), /Semantic degradation/u);
});
