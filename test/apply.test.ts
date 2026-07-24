import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  AlembicControlPlane,
  applyPlan,
  canonicalJson,
  createPlan,
  inspectConfig,
  resumeOperation,
  semanticFingerprint,
  sha256,
  verifyPlan
} from "../src/index.js";
import {
  localBuildSelection,
  MockSeedbed,
  MockWorkshop,
  expectedStatus,
  protectedToken,
  temporaryProject,
  workshopStatus
} from "./helpers.js";

test("Docker-local apply invokes Seedbed, verifies protocol, writes config last, and requires new task", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: localBuildSelection,
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
    image: localBuildSelection,
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
    image: localBuildSelection,
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

test("completed local repair resumes the recorded Seedbed operation and freshly verifies Workshop", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: localBuildSelection,
    expected: expectedStatus
  };
  const plan = await createPlan({
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "repair",
    mode: "docker-local",
    endpoint: docker.endpoint,
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected: expectedStatus,
    docker
  }, seedbed);
  const initial = await applyPlan(plan, { seedbed, workshopTransport: new MockWorkshop() });
  assert.equal(initial.state, "activation-required");
  const stoppedWorkshop = {
    async call() {
      throw new Error("ECONNREFUSED secret-path-must-not-surface");
    }
  };
  await assert.rejects(
    resumeOperation(root, plan.operationId, { seedbed, workshopTransport: stoppedWorkshop }),
    (error) => {
      assert.equal((error as { code?: string }).code, "workshop-stopped");
      assert.doesNotMatch(String((error as Error).message), /ECONNREFUSED|secret-path/u);
      return true;
    }
  );
  assert.equal(seedbed.resumed, 1);
  const diagnosis = await new AlembicControlPlane({ seedbed }).diagnose({
    taskDirectory: root,
    confirmedProjectRoot: root,
    operationId: plan.operationId,
    installationId: expectedStatus.installationId
  });
  assert.equal(diagnosis.classification, "workshop-stopped");
  assert.equal(diagnosis.repair, "resume-exact-operation");
  const repaired = await resumeOperation(root, plan.operationId, {
    seedbed,
    workshopTransport: new MockWorkshop()
  });
  assert.equal(repaired.state, "activation-required");
  assert.equal(repaired.failureClassification, "none");
  assert.match(repaired.message, /freshly verified/u);
  assert.equal(seedbed.resumed, 2);
  assert.equal(repaired.configAfterDigest, initial.configAfterDigest);
});

test("recorded Seedbed repair failure is stable, redacted, and retryable", async () => {
  class FailingResumeSeedbed extends MockSeedbed {
    override async resume(): Promise<never> {
      throw new Error("docker secret internal failure");
    }
  }
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const seedbed = new FailingResumeSeedbed(protectedCredential.path, protectedCredential.digest);
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: localBuildSelection,
    expected: expectedStatus
  };
  const plan = await createPlan({
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "repair",
    mode: "docker-local",
    endpoint: docker.endpoint,
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected: expectedStatus,
    docker
  }, seedbed);
  await applyPlan(plan, { seedbed, workshopTransport: new MockWorkshop() });
  await assert.rejects(
    resumeOperation(root, plan.operationId, { seedbed, workshopTransport: new MockWorkshop() }),
    (error) => {
      assert.equal((error as { code?: string }).code, "seedbed-repair-failed");
      assert.doesNotMatch(String((error as Error).message), /docker secret internal/u);
      return true;
    }
  );
  const diagnosis = await new AlembicControlPlane({ seedbed }).diagnose({
    taskDirectory: root,
    confirmedProjectRoot: root,
    operationId: plan.operationId,
    installationId: expectedStatus.installationId
  });
  assert.equal(diagnosis.classification, "repair-failed");
  assert.equal(diagnosis.repair, "resume-exact-operation");
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
    image: localBuildSelection,
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
    image: localBuildSelection,
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
  await assert.rejects(
    createPlan({
      taskDirectory: root,
      confirmedProjectRoot: root,
      action: "create",
      mode: "docker-local",
      endpoint: docker.endpoint,
      authentication: {
        kind: "environment",
        variable: "GNOLITH_BEARER_TOKEN",
        token: "SECRET_CANARY_REJECTED"
      },
      expected: expectedStatus,
      docker
    } as unknown as Parameters<typeof createPlan>[0], seedbed),
    /unapproved field/u
  );
  assert.equal(seedbed.applied, 0);
});

test("local-build trust accepts only the exact Seedbed selector and rejects tampered attestations", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: localBuildSelection,
    expected: expectedStatus
  };
  const request = {
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "create" as const,
    mode: "docker-local" as const,
    endpoint: docker.endpoint,
    authentication: { kind: "environment" as const, variable: "GNOLITH_BEARER_TOKEN" as const },
    expected: expectedStatus,
    docker
  };
  const plan = await createPlan(request, seedbed);
  assert.equal(plan.seedbedLocalBuildTrust?.localBuild.selector, "gnolith-seedbed-local-build-v1");
  assert.equal(plan.seedbedLocalBuildTrust?.localBuild.pullPolicy, "never");

  for (const field of ["componentLockSha256", "graphSha256"] as const) {
    const changed = {
      ...plan,
      seedbedLocalBuildTrust: {
        ...plan.seedbedLocalBuildTrust!,
        localBuild: {
          ...plan.seedbedLocalBuildTrust!.localBuild,
          [field]: "0".repeat(64)
        }
      }
    };
    const unsigned = Object.fromEntries(
      Object.entries(changed).filter(([key]) => key !== "digest")
    ) as Omit<typeof changed, "digest">;
    assert.throws(
      () => verifyPlan({ ...unsigned, digest: sha256(canonicalJson(unsigned)) }),
      /trust evidence differs/u
    );
  }

  await assert.rejects(
    createPlan({
      ...request,
      docker: {
        ...docker,
        image: { ...localBuildSelection, selector: "gnolith-seedbed-local-build-v2" }
      }
    } as unknown as Parameters<typeof createPlan>[0], seedbed),
    /exact attested Seedbed local build/u
  );
  await assert.rejects(
    createPlan({
      ...request,
      docker: {
        ...docker,
        image: {
          kind: "digest-qualified-pulled-image-v1",
          reference: "ghcr.io/gnolith/workshop:latest",
          pullPolicy: "digest-only"
        }
      }
    }, seedbed),
    /digest-qualified pulled image/u
  );
  await assert.rejects(
    createPlan({
      ...request,
      docker: {
        ...docker,
        image: {
          kind: "digest-qualified-pulled-image-v1",
          reference: `ghcr.io/gnolith/workshop@sha256:${"a".repeat(64)}`,
          pullPolicy: "digest-only"
        }
      }
    }, seedbed),
    /exact pinned local-build selector/u
  );
});

test("semantic planning binds a redacted profile and only approved Compose-private endpoints", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const unsignedSemantic = {
    format: "gnolith-semantic-configuration-v1" as const,
    revision: 3,
    provider: {
      kind: "ollama-v1" as const,
      endpoint: "http://ollama:11434",
      model: "nomic-embed-text",
      modelDigest: "a".repeat(64),
      dimensions: 768,
      privateNetworkApproved: true as const
    },
    vector: {
      kind: "qdrant-v1" as const,
      endpoint: "http://qdrant:6333",
      collection: "gnolith-semantic",
      dimensions: 768,
      privateNetworkApproved: true as const
    },
    credentialSelectors: []
  };
  const semantic = {
    ...unsignedSemantic,
    fingerprint: semanticFingerprint(unsignedSemantic)
  };
  const docker = {
    installationId: expectedStatus.installationId,
    baseIri: expectedStatus.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: localBuildSelection,
    semantic,
    expected: expectedStatus
  };
  const request = {
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "create" as const,
    mode: "docker-local" as const,
    endpoint: docker.endpoint,
    authentication: { kind: "environment" as const, variable: "GNOLITH_BEARER_TOKEN" as const },
    expected: expectedStatus,
    docker
  };
  const plan = await createPlan(request, seedbed);
  assert.deepEqual(plan.semanticProfile, {
    format: "gnolith-alembic-semantic-profile-v1",
    revision: 3,
    fingerprint: semantic.fingerprint,
    providerKind: "ollama-v1",
    vectorKind: "qdrant-v1",
    providerEndpoint: "http://ollama:11434",
    vectorEndpoint: "http://qdrant:6333",
    credentialSelectorIds: []
  });
  assert.doesNotMatch(JSON.stringify(plan.semanticProfile), /protected-token|canonical_token/u);
  const receipt = await applyPlan(plan, {
    seedbed,
    workshopTransport: new MockWorkshop({
      ...workshopStatus,
      semanticState: {
        state: "ready",
        configured: true,
        revision: 3,
        fingerprint: semantic.fingerprint,
        ready: true
      }
    })
  });
  assert.equal(receipt.state, "activation-required");

  const badPrivate = {
    ...semantic,
    provider: { ...semantic.provider, endpoint: "http://10.0.0.9:11434" }
  };
  badPrivate.fingerprint = semanticFingerprint(badPrivate);
  await assert.rejects(
    createPlan({
      ...request,
      docker: { ...docker, semantic: badPrivate }
    }, seedbed),
    /explicitly approved Compose-local profile target/u
  );
  await assert.rejects(
    createPlan({
      ...request,
      docker: {
        ...docker,
        semantic: {
          ...semantic,
          credentialSelectors: [{
            id: "forbidden-secret",
            kind: "protected-file-v1",
            path: protectedCredential.path,
            value: "SECRET_VALUE_MUST_BE_REJECTED"
          }]
        }
      }
    } as unknown as Parameters<typeof createPlan>[0], seedbed),
    /unapproved field/u
  );

  const changed = {
    ...plan,
    semanticProfile: { ...plan.semanticProfile!, revision: 4 }
  };
  const unsigned = Object.fromEntries(
    Object.entries(changed).filter(([key]) => key !== "digest")
  ) as Omit<typeof changed, "digest">;
  assert.throws(
    () => verifyPlan({ ...unsigned, digest: sha256(canonicalJson(unsigned)) }),
    /Semantic profile differs/u
  );
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
  await assert.rejects(verifyWorkshop({ ...common, transport: new MockWorkshop(workshopStatus, "not-gnolith") }), /identity/u);
  await assert.rejects(verifyWorkshop({ ...common, transport: new MockWorkshop(workshopStatus, "gnolith", ["health"]) }), /gnolith_status/u);
  await assert.rejects(verifyWorkshop({
    ...common,
    expected: { ...expectedStatus, semanticState: "degraded", allowLexicalOnly: false },
    transport: new MockWorkshop({ ...workshopStatus, semanticState: { state: "degraded", configured: true } })
  }), /Semantic degradation/u);
});
