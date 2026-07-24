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
  verifyPlan,
  WORKSHOP_TOOL_NAMES
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
import type {
  InstallationSelector,
  SeedbedCallOptions
} from "../src/types.js";

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

test("diagnosis bounds hung Seedbed calls and prioritizes stopped Workshop over activation", async () => {
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
  const applied = await applyPlan(plan, { seedbed, workshopTransport: new MockWorkshop() });
  assert.equal(applied.state, "activation-required");

  const stopped = await new AlembicControlPlane({ seedbed }).diagnose({
    taskDirectory: root,
    confirmedProjectRoot: root,
    operationId: plan.operationId,
    installationId: expectedStatus.installationId
  });
  assert.equal(stopped.classification, "workshop-stopped");
  assert.equal(stopped.repair, "resume-exact-operation");

  class HangingDiagnoseSeedbed extends MockSeedbed {
    aborted = false;
    override async diagnose(
      _request?: InstallationSelector,
      options?: SeedbedCallOptions
    ): ReturnType<MockSeedbed["diagnose"]> {
      return new Promise((_resolve, reject) => {
        options?.signal.addEventListener("abort", () => {
          this.aborted = true;
          reject(new Error("unbounded-child-secret-must-not-surface"));
        }, { once: true });
      });
    }
  }
  const hanging = new HangingDiagnoseSeedbed(protectedCredential.path, protectedCredential.digest);
  const timedOut = await new AlembicControlPlane({
    seedbed: hanging,
    diagnoseDeadlineMs: 5
  }).diagnose({
    taskDirectory: root,
    confirmedProjectRoot: root,
    operationId: plan.operationId,
    installationId: expectedStatus.installationId
  });
  assert.equal(hanging.aborted, true);
  assert.equal(timedOut.classification, "seedbed-timeout");
  assert.equal(timedOut.repair, "resume-exact-operation");
  assert.deepEqual(timedOut.seedbed, {
    installationId: expectedStatus.installationId,
    classification: "timeout",
    repairBound: true
  });
  assert.doesNotMatch(JSON.stringify(timedOut), /unbounded-child-secret/u);
});

test("hung Seedbed apply is aborted and records a stable retryable timeout", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const planningSeedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
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
  }, planningSeedbed);
  class HangingApplySeedbed extends MockSeedbed {
    aborted = false;
    override async apply(
      _plan: Parameters<MockSeedbed["apply"]>[0],
      options?: SeedbedCallOptions
    ): Promise<Awaited<ReturnType<MockSeedbed["apply"]>>> {
      return new Promise((_resolve, reject) => {
        options?.signal.addEventListener("abort", () => {
          this.aborted = true;
          reject(new Error("child-process-secret-must-not-surface"));
        }, { once: true });
      });
    }
  }
  const hanging = new HangingApplySeedbed(protectedCredential.path, protectedCredential.digest);
  await assert.rejects(
    applyPlan(plan, {
      seedbed: hanging,
      seedbedDeadlineMs: 5,
      workshopTransport: new MockWorkshop()
    }),
    (error) => {
      assert.equal((error as { code?: string }).code, "seedbed-apply-timeout");
      assert.doesNotMatch(String((error as Error).message), /child-process-secret/u);
      return true;
    }
  );
  assert.equal(hanging.aborted, true);
  const stored = await new AlembicControlPlane().operationRead({
    taskDirectory: root,
    confirmedProjectRoot: root,
    operationId: plan.operationId
  });
  assert.equal(stored.state, "failed");
  assert.equal(stored.failureClassification, "seedbed-timeout");
  assert.equal(stored.seedbed?.operationId, plan.seedbedPlan?.id);
  assert.doesNotMatch(stored.message, /child-process-secret/u);
  const recovery = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const resumed = await new AlembicControlPlane({
    seedbed: recovery,
    workshopTransport: new MockWorkshop()
  }).operationResume({
    taskDirectory: root,
    confirmedProjectRoot: root,
    operationId: plan.operationId
  });
  assert.equal(recovery.applied, 0);
  assert.equal(recovery.resumed, 1);
  assert.equal(resumed.state, "activation-required");
});

test("trailing-slash and no-slash base identities share one replay-safe canonical plan", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const slashExpected = { ...expectedStatus, baseIri: `${expectedStatus.baseIri}/` };
  const slashDocker = {
    installationId: slashExpected.installationId,
    baseIri: slashExpected.baseIri,
    endpoint: "http://127.0.0.1/mcp",
    image: localBuildSelection,
    expected: slashExpected
  };
  const slashRequest = {
    taskDirectory: root,
    confirmedProjectRoot: root,
    action: "create" as const,
    mode: "docker-local" as const,
    endpoint: slashDocker.endpoint,
    authentication: { kind: "environment" as const, variable: "GNOLITH_BEARER_TOKEN" as const },
    expected: slashExpected,
    docker: slashDocker
  };
  const slashPlan = await createPlan(slashRequest, seedbed);
  const canonicalPlan = await createPlan({
    ...slashRequest,
    expected: expectedStatus,
    docker: {
      ...slashDocker,
      baseIri: expectedStatus.baseIri,
      expected: expectedStatus
    }
  }, seedbed);
  assert.equal(slashPlan.expected.baseIri, expectedStatus.baseIri);
  assert.equal(slashPlan.seedbedPlan?.request.baseIri, expectedStatus.baseIri);
  assert.equal(slashPlan.requestDigest, canonicalPlan.requestDigest);
  await assert.rejects(
    createPlan({
      ...slashRequest,
      expected: { ...slashExpected, baseIri: "https://example.test/other/" }
    }, seedbed),
    /canonical identities differ/u
  );

  const applied = await applyPlan(slashPlan, {
    seedbed,
    workshopTransport: new MockWorkshop({
      ...workshopStatus,
      baseIri: `${expectedStatus.baseIri}/`
    })
  });
  const replayed = await applyPlan(slashPlan, {
    seedbed,
    workshopTransport: new MockWorkshop()
  });
  assert.deepEqual(replayed, applied);
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

test("default local plan and receipt require identical Waystone /app evidence", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
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
  class MissingWaystoneSeedbed extends MockSeedbed {
    override async plan(input: Parameters<MockSeedbed["plan"]>[0]) {
      const planned = await super.plan(input);
      const withoutWaystone = { ...planned };
      delete withoutWaystone.waystone;
      return withoutWaystone;
    }
  }
  await assert.rejects(
    createPlan(request, new MissingWaystoneSeedbed(protectedCredential.path, protectedCredential.digest)),
    /required default Waystone profile/u
  );

  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const plan = await createPlan(request, seedbed);
  class MismatchedWaystoneSeedbed extends MockSeedbed {
    override async apply(input: Parameters<MockSeedbed["apply"]>[0]) {
      const receipt = await super.apply(input);
      return {
        ...receipt,
        waystone: {
          ...receipt.waystone!,
          manifestSha256: "0".repeat(64)
        }
      };
    }
  }
  await assert.rejects(
    applyPlan(plan, {
      seedbed: new MismatchedWaystoneSeedbed(protectedCredential.path, protectedCredential.digest),
      workshopTransport: new MockWorkshop()
    }),
    /Waystone evidence differs/u
  );
  assert.equal((await inspectConfig(join(root, ".codex", "config.toml"))).digest, null);
});

test("semantic planning binds a redacted profile and only approved Compose-private endpoints", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const configuration = {
    version: 1 as const,
    id: "semantic-main",
    name: "Semantic Main",
    provider: {
      kind: "openai-compatible" as const,
      endpoint: "https://api.example.test/v1",
      model: "text-embedding-model",
      dimensions: 1536,
      metric: "cosine" as const,
      credentialSelector: "openai-api-key",
      allowPrivateEndpoint: false,
      redirectPolicy: "error" as const
    },
    vector: {
      kind: "qdrant" as const,
      endpoint: "http://qdrant:6333",
      collection: "gnolith-semantic",
      credentialSelector: null,
      allowPrivateEndpoint: true,
      redirectPolicy: "error" as const
    }
  };
  const semantic = {
    configuration,
    expectedRevision: 2,
    credentialSelectors: [{
      id: "openai-api-key",
      kind: "protected-file-v1" as const,
      path: protectedCredential.path
    }]
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
    fingerprint: semanticFingerprint(configuration),
    configurationId: "semantic-main",
    providerKind: "openai-compatible",
    vectorKind: "qdrant",
    providerEndpoint: "https://api.example.test/v1",
    vectorEndpoint: "http://qdrant:6333",
    credentialSelectorIds: ["openai-api-key"]
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
        fingerprint: semanticFingerprint(configuration),
        ready: true
      }
    })
  });
  assert.equal(receipt.state, "activation-required");
  assert.deepEqual(receipt.semanticVerification, {
    state: "ready",
    configured: true,
    revision: 3,
    fingerprint: semanticFingerprint(configuration),
    ready: true
  });

  const badPrivate = {
    ...semantic,
    configuration: {
      ...semantic.configuration,
      provider: {
        ...semantic.configuration.provider,
        endpoint: "http://10.0.0.9:11434",
        allowPrivateEndpoint: true
      }
    }
  };
  await assert.rejects(
    createPlan({
      ...request,
      docker: { ...docker, semantic: badPrivate }
    }, seedbed),
    /explicitly approved literal loopback or Compose-local target/u
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

  const publicSemantic = {
    configuration: {
      version: 1 as const,
      id: "semantic-public",
      name: "Semantic Public",
      provider: {
        kind: "openai-compatible" as const,
        endpoint: "https://api.example.test/v1/",
        model: "text-embedding-model",
        dimensions: 1536,
        metric: "cosine" as const,
        credentialSelector: "openai-api-key",
        allowPrivateEndpoint: false,
        redirectPolicy: "error" as const
      },
      vector: { kind: "sqlite" as const }
    },
    expectedRevision: 0,
    credentialSelectors: [{
      id: "openai-api-key",
      kind: "protected-file-v1" as const,
      path: protectedCredential.path
    }]
  };
  const publicPlan = await createPlan({
    ...request,
    docker: { ...docker, semantic: publicSemantic }
  }, seedbed);
  assert.equal(publicPlan.semanticProfile?.providerEndpoint, "https://api.example.test/v1");
  assert.deepEqual(publicPlan.semanticProfile?.credentialSelectorIds, ["openai-api-key"]);
  assert.equal(JSON.stringify(publicPlan.semanticProfile).includes(protectedCredential.path), false);

  await assert.rejects(
    createPlan({
      ...request,
      docker: {
        ...docker,
        semantic: {
          ...publicSemantic,
          configuration: {
            ...publicSemantic.configuration,
            provider: {
              ...publicSemantic.configuration.provider,
              endpoint: "https://192.168.1.40/v1"
            }
          }
        }
      }
    }, seedbed),
    /public endpoint/u
  );

  const ollamaConfiguration = {
    ...configuration,
    id: "semantic-ollama",
    name: "Semantic Ollama",
    provider: {
      kind: "ollama-compatible" as const,
      endpoint: "http://ollama:11434",
      model: "nomic-embed-text",
      dimensions: 768,
      metric: "cosine" as const,
      credentialSelector: null,
      allowPrivateEndpoint: true,
      redirectPolicy: "error" as const
    },
    vector: { kind: "sqlite" as const }
  };
  const ollamaProfile = {
    format: "gnolith-alembic-semantic-profile-v1" as const,
    revision: 1,
    fingerprint: semanticFingerprint(ollamaConfiguration),
    configurationId: ollamaConfiguration.id,
    providerKind: "ollama-compatible" as const,
    vectorKind: "sqlite" as const,
    providerEndpoint: "http://ollama:11434",
    vectorEndpoint: null,
    credentialSelectorIds: []
  };
  const { verifyWorkshop } = await import("../src/workshop.js");
  const ollamaDegraded = await verifyWorkshop({
    endpoint: docker.endpoint,
    mode: "docker-local",
    authentication: request.authentication,
    expected: { ...expectedStatus, semanticState: "degraded", allowLexicalOnly: true },
    semanticProfile: ollamaProfile,
    protectedFile: {
      kind: "protected-file",
      canonicalPath: protectedCredential.path,
      credentialId: "credential-test",
      sha256: protectedCredential.digest
    },
    transport: new MockWorkshop({
      ...workshopStatus,
      semanticState: {
        state: "degraded",
        configured: true,
        revision: 1,
        fingerprint: ollamaProfile.fingerprint,
        ready: false
      }
    })
  });
  assert.equal(ollamaDegraded.status.semanticState.state, "degraded");
  assert.equal(ollamaDegraded.status.semanticState.ready, false);
  await assert.rejects(
    verifyWorkshop({
      endpoint: docker.endpoint,
      mode: "docker-local",
      authentication: request.authentication,
      expected: expectedStatus,
      semanticProfile: ollamaProfile,
      protectedFile: {
        kind: "protected-file",
        canonicalPath: protectedCredential.path,
        credentialId: "credential-test",
        sha256: protectedCredential.digest
      },
      transport: new MockWorkshop({
        ...workshopStatus,
        semanticState: {
          state: "ready",
          configured: true,
          revision: 1,
          fingerprint: ollamaProfile.fingerprint,
          ready: true
        }
      })
    }),
    /immutable model artifact/u
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

test("protected loopback OpenAI-compatible SQLite profile is accepted, redacted, and verified", async () => {
  const root = await temporaryProject();
  const protectedCredential = await protectedToken(root);
  process.env.GNOLITH_BEARER_TOKEN = protectedCredential.token;
  const seedbed = new MockSeedbed(protectedCredential.path, protectedCredential.digest);
  const configuration = {
    version: 1 as const,
    id: "semantic-loopback",
    name: "Semantic Loopback",
    provider: {
      kind: "openai-compatible" as const,
      endpoint: "http://127.0.0.1:43117/mock",
      model: "mock-embedding",
      dimensions: 16,
      metric: "cosine" as const,
      credentialSelector: "loopback-openai-key",
      allowPrivateEndpoint: true,
      redirectPolicy: "error" as const
    },
    vector: { kind: "sqlite" as const }
  };
  const semantic = {
    configuration,
    expectedRevision: 4,
    credentialSelectors: [{
      id: "loopback-openai-key",
      kind: "protected-file-v1" as const,
      path: protectedCredential.path
    }]
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
    revision: 5,
    fingerprint: semanticFingerprint(configuration),
    configurationId: configuration.id,
    providerKind: "openai-compatible",
    vectorKind: "sqlite",
    providerEndpoint: configuration.provider.endpoint,
    vectorEndpoint: null,
    credentialSelectorIds: ["loopback-openai-key"]
  });
  assert.doesNotMatch(JSON.stringify(plan.semanticProfile), new RegExp(protectedCredential.path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  const receipt = await applyPlan(plan, {
    seedbed,
    workshopTransport: new MockWorkshop({
      ...workshopStatus,
      semanticState: {
        state: "ready",
        configured: true,
        revision: 5,
        fingerprint: semanticFingerprint(configuration),
        ready: true
      }
    })
  });
  assert.deepEqual(receipt.semanticVerification, {
    state: "ready",
    configured: true,
    revision: 5,
    fingerprint: semanticFingerprint(configuration),
    ready: true
  });

  await assert.rejects(
    createPlan({
      ...request,
      docker: {
        ...docker,
        semantic: {
          ...semantic,
          configuration: {
            ...configuration,
            provider: {
              ...configuration.provider,
              endpoint: "http://localhost:43117/mock"
            }
          }
        }
      }
    }, seedbed),
    /literal loopback or Compose-local/u
  );
  await assert.rejects(
    createPlan({
      ...request,
      docker: {
        ...docker,
        semantic: {
          ...semantic,
          configuration: {
            ...configuration,
            provider: {
              ...configuration.provider,
              endpoint: "http://127.0.0.1:43117/mock?redirect=http://10.0.0.1"
            }
          }
        }
      }
    }, seedbed),
    /literal loopback or Compose-local/u
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
  await assert.rejects(
    verifyWorkshop({
      ...common,
      transport: new MockWorkshop(workshopStatus, "gnolith", WORKSHOP_TOOL_NAMES.slice(0, -1))
    }),
    /52-operation catalog/u
  );
  await assert.rejects(
    verifyWorkshop({
      ...common,
      transport: new MockWorkshop({
        ...workshopStatus,
        migrationReadiness: { ...workshopStatus.migrationReadiness, version: 10 as 11 }
      })
    }),
    /pinned Workshop schema/u
  );
  await assert.rejects(verifyWorkshop({
    ...common,
    expected: { ...expectedStatus, semanticState: "degraded", allowLexicalOnly: false },
    transport: new MockWorkshop({
      ...workshopStatus,
      semanticState: {
        state: "degraded",
        configured: true,
        revision: 1,
        fingerprint: "a".repeat(64),
        ready: false
      }
    })
  }), /Semantic degradation/u);
});
