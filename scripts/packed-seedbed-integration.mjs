import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [alembicArchive, seedbedArchive, workshopArchive] = process.argv.slice(2);
if (!alembicArchive || !seedbedArchive || !workshopArchive) {
  throw new Error("Exact Alembic, Seedbed, and Workshop archives are required");
}
const root = await mkdtemp(join(tmpdir(), "alembic-packed-seedbed-"));
const projectRoot = join(root, "project");
const stateRoot = join(root, "state");
const emptyPath = join(root, "no-executables");
await Promise.all([
  mkdir(join(projectRoot, ".codex"), { recursive: true }),
  mkdir(stateRoot, { recursive: true }),
  mkdir(emptyPath, { recursive: true })
]);

try {
  const npmCli = process.env.npm_execpath ??
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmCommand = process.execPath;
  const npmPrefix = [npmCli];
  await exec(
    npmCommand,
    [
      ...npmPrefix,
      "install",
      "--prefix",
      root,
      "--ignore-scripts",
      "--package-lock=false",
      "--legacy-peer-deps",
      alembicArchive,
      seedbedArchive,
      workshopArchive
    ],
    { maxBuffer: 20 * 1024 * 1024 }
  );
  const alembicRoot = join(root, "node_modules", "@gnolith", "alembic");
  const alembic = await import(pathToFileURL(join(alembicRoot, "dist", "index.js")).href);
  const workshopContract = await import(pathToFileURL(
    join(root, "node_modules", "@gnolith", "workshop", "dist", "protocol", "catalog.js")
  ).href);
  assert.equal(alembic.TOOL_NAMES.length, 9);
  assert.equal(new Set(alembic.TOOL_NAMES).size, 9);
  assert.equal(workshopContract.OPERATION_SCHEMA_VERSION, 2);
  assert.equal(
    workshopContract.CATALOG_DIGEST,
    "a57799a792a075a5e359567240a7241a48df4155fae3a9e73b092ccf9035955b"
  );
  assert.deepEqual(
    workshopContract.operationCatalog.map(({ name }) => name),
    [...alembic.WORKSHOP_TOOL_NAMES]
  );
  const outsideBundle = join(root, "outside-project-bundle.json");
  await writeFile(outsideBundle, "{}");
  const packedControl = new alembic.AlembicControlPlane();
  await assert.rejects(
    packedControl.legacyInspect({
      bundlePath: outsideBundle,
      taskDirectory: projectRoot,
      confirmedProjectRoot: projectRoot,
      packageName: "@gnolith/codex-plugin",
      packageVersion: "0.2.0"
    }),
    (error) => {
      assert.equal(error.code, "legacy-bundle-scope");
      assert.equal(error.message, "Legacy bundle must be an exact regular file inside the attested project");
      assert.doesNotMatch(JSON.stringify(error), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      return true;
    }
  );

  const factory = await alembic.loadDefaultSeedbedFactory();
  const exactSeedbed = factory(projectRoot, stateRoot);
  const token = "packed_exact_local_token";
  const tokenPath = join(stateRoot, "packed-token");
  const semanticCredentialPath = join(stateRoot, "packed-openai-key");
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await writeFile(semanticCredentialPath, "packed_openai_key\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(tokenPath, 0o600);
    await chmod(semanticCredentialPath, 0o600);
  }
  process.env.GNOLITH_BEARER_TOKEN = token;
  const expected = {
    installationId: "packed-integration",
    baseIri: "https://example.test/packed/",
    serverVersion: "0.5.0",
    operationVersion: "2",
    catalogDigest: "a57799a792a075a5e359567240a7241a48df4155fae3a9e73b092ccf9035955b",
    migrationReady: true,
    canonicalReady: true,
    authorizationReady: true,
    lexicalReady: true,
    blobReady: true,
    producerStatus: "ready",
    semanticState: "ready",
    allowLexicalOnly: false
  };
  const semanticConfiguration = {
    version: 1,
    id: "packed-semantic",
    name: "Packed Semantic",
    provider: {
      kind: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      model: "text-embedding-model",
      dimensions: 1536,
      metric: "cosine",
      credentialSelector: "packed-openai-key",
      allowPrivateEndpoint: false,
      redirectPolicy: "error"
    },
    vector: {
      kind: "qdrant",
      endpoint: "http://qdrant:6333",
      collection: "packed-semantic",
      credentialSelector: null,
      allowPrivateEndpoint: true,
      redirectPolicy: "error"
    }
  };
  const semanticFingerprint = alembic.semanticFingerprint(semanticConfiguration);
  const docker = {
    installationId: expected.installationId,
    baseIri: expected.baseIri,
    endpoint: "http://127.0.0.1:4317/mcp",
    image: {
      kind: "seedbed-local-build-v1",
      selector: "gnolith-seedbed-local-build-v1",
      pullPolicy: "never",
      componentLockSha256: "b96cc5bfb4f73413e12d8cffd13dd8f9f97f3ca8ffffcefcd576176c521f3190",
      graphSha256: "15ad77b7e178bd76f4ea32d1c1570f8d287caf52b6bd87bc286ffd36f2ad34a9",
      composeBundleSha256: "2a0f1e69f9fb2a4aeb8e906c5db3aec091cfcf52d8af0be65088da251d38235a"
    },
    semantic: {
      configuration: semanticConfiguration,
      expectedRevision: 0,
      credentialSelectors: [{
        id: "packed-openai-key",
        kind: "protected-file-v1",
        path: semanticCredentialPath
      }]
    },
    expected
  };
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Packed integration forbids network access");
  };
  process.env.PATH = emptyPath;
  const seedbedPlan = await exactSeedbed.plan(docker);
  assert.equal(seedbedPlan.request.image.selector, "gnolith-seedbed-local-build-v1");
  assert.equal(seedbedPlan.request.image.pullPolicy, "never");

  let semanticReceiptOverride = null;
  const packedSeedbedReceipt = (plan) => ({
    operationId: plan.id,
    state: "ready",
    version: "0.4.0",
    digest: plan.digest,
    endpoint: plan.request.endpoint,
    installationId: plan.request.installationId,
    baseIri: plan.request.baseIri,
    expected: plan.request.expected,
    semantic: semanticReceiptOverride ?? {
      fingerprint: semanticFingerprint,
      revision: 1,
      state: "ready"
    },
    protectedTokenFile: {
      kind: "protected-file",
      canonicalPath: tokenPath,
      credentialId: "packed-credential",
      sha256: alembic.sha256(token)
    },
    environmentSelector: "GNOLITH_BEARER_TOKEN"
  });
  let seedbedResumeCalls = 0;
  const seedbed = {
    inspect: (selector) => exactSeedbed.inspect(selector),
    plan: (request) => exactSeedbed.plan(request),
    apply: async (approvedPlan) => packedSeedbedReceipt(approvedPlan),
    resume: async (operationId) => {
      assert.equal(operationId, seedbedPlan.id);
      seedbedResumeCalls += 1;
      return packedSeedbedReceipt(seedbedPlan);
    },
    diagnose: async (selector) => ({
      installationId: selector.installationId,
      classification: "local-workshop-unavailable",
      repair: {
        kind: "seedbed-resume-operation-v1",
        operationId: seedbedPlan.id,
        action: "restart-recorded-compose"
      }
    })
  };
  const plan = await alembic.createPlan({
    taskDirectory: projectRoot,
    confirmedProjectRoot: projectRoot,
    action: "create",
    mode: "docker-local",
    endpoint: docker.endpoint,
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected,
    docker
  }, seedbed);
  assert.deepEqual(plan.seedbedPlan.request, seedbedPlan.request);
  assert.equal(plan.seedbedLocalBuildTrust.seedbedCandidateSha256, "6dff7d30c48e9c807dd81bbff9e2f650287b374997764c8e2a543f33232a284f");
  assert.equal(plan.semanticProfile.fingerprint, semanticFingerprint);
  assert.equal(plan.semanticProfile.revision, 1);
  assert.equal(JSON.stringify(plan.semanticProfile).includes(semanticCredentialPath), false);

  const workshopStatus = {
    installationId: expected.installationId,
    baseIri: expected.baseIri,
    principalId: "packed-principal",
    credentialId: "packed-credential",
    activeWorkspaceId: null,
    capabilities: ["gnolith:use"],
    authorizationRevision: 1,
    migrationReadiness: { namespace: "@gnolith/workshop", version: 11, ready: true },
    compatibility: { diamond: true, taproot: true },
    canonicalReady: true,
    authorizationReady: true,
    lexicalReady: true,
    semanticState: {
      state: "ready",
      configured: true,
      revision: 1,
      fingerprint: semanticFingerprint,
      ready: true
    },
    producers: { ready: true, fingerprint: "packed", kinds: ["task", "memory", "prompt"] },
    blobReady: true,
    versions: { server: "0.5.0", operationSchema: 2 },
    operationCatalogDigest: expected.catalogDigest
  };
  const workshopTransportFor = (status) => ({
    async call(_endpoint, _token, method) {
      if (method === "initialize") {
        return {
          response: {
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-06-18", serverInfo: { name: "gnolith" } }
          },
          sessionId: "packed-session"
        };
      }
      if (method === "tools/list") {
        return {
          response: {
            jsonrpc: "2.0",
            id: 1,
            result: { tools: alembic.WORKSHOP_TOOL_NAMES.map((name) => ({ name })) }
          }
        };
      }
      return {
        response: {
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: status }
        }
      };
    }
  });
  const workshopTransport = workshopTransportFor(workshopStatus);
  semanticReceiptOverride = {
    fingerprint: "0".repeat(64),
    revision: 1,
    state: "ready"
  };
  await assert.rejects(
    alembic.applyPlan(plan, { seedbed, workshopTransport }),
    /Seedbed semantic receipt differs/u
  );
  semanticReceiptOverride = null;
  const receipt = await alembic.resumeOperation(projectRoot, plan.operationId, {
    seedbed,
    workshopTransport
  });
  assert.equal(receipt.state, "activation-required");
  assert.deepEqual(receipt.semanticVerification, workshopStatus.semanticState);
  const verificationInput = {
    endpoint: docker.endpoint,
    mode: "docker-local",
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    expected,
    semanticProfile: plan.semanticProfile,
    protectedFile: packedSeedbedReceipt(seedbedPlan).protectedTokenFile
  };
  for (const semanticState of [
    { ...workshopStatus.semanticState, fingerprint: "0".repeat(64) },
    { ...workshopStatus.semanticState, revision: 2 },
    { ...workshopStatus.semanticState, state: "degraded", ready: false }
  ]) {
    await assert.rejects(
      alembic.verifyWorkshop({
        ...verificationInput,
        transport: workshopTransportFor({ ...workshopStatus, semanticState })
      }),
      /semantic|status mismatch/u
    );
  }
  assert.equal(fetchCalls, 0);
  const stoppedTransport = {
    async call() {
      throw new Error("ECONNREFUSED packed-secret-path");
    }
  };
  await assert.rejects(
    alembic.resumeOperation(projectRoot, plan.operationId, {
      seedbed,
      workshopTransport: stoppedTransport
    }),
    (error) => {
      assert.equal(error.code, "workshop-stopped");
      assert.doesNotMatch(error.message, /ECONNREFUSED|packed-secret-path/u);
      return true;
    }
  );
  assert.equal(seedbedResumeCalls, 1);
  const stoppedDiagnosis = await new alembic.AlembicControlPlane({ seedbed }).diagnose({
    taskDirectory: projectRoot,
    confirmedProjectRoot: projectRoot,
    operationId: plan.operationId,
    installationId: expected.installationId
  });
  assert.equal(stoppedDiagnosis.classification, "workshop-stopped");
  assert.equal(stoppedDiagnosis.repair, "resume-exact-operation");
  const repaired = await alembic.resumeOperation(projectRoot, plan.operationId, {
    seedbed,
    workshopTransport
  });
  assert.equal(repaired.state, "activation-required");
  assert.equal(repaired.failureClassification, "none");
  assert.equal(seedbedResumeCalls, 2);
  assert.equal(fetchCalls, 0);

  await assert.rejects(
    alembic.createPlan({
      taskDirectory: projectRoot,
      confirmedProjectRoot: projectRoot,
      action: "create",
      mode: "docker-local",
      endpoint: docker.endpoint,
      authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
      expected,
      docker: {
        ...docker,
        image: { ...docker.image, selector: "gnolith-seedbed-local-build-v2" }
      }
    }, seedbed),
    /exact attested Seedbed local build/u
  );

  const changedGraph = {
    ...plan,
    seedbedLocalBuildTrust: {
      ...plan.seedbedLocalBuildTrust,
      localBuild: {
        ...plan.seedbedLocalBuildTrust.localBuild,
        graphSha256: "0".repeat(64)
      }
    }
  };
  const changedGraphUnsigned = Object.fromEntries(
    Object.entries(changedGraph).filter(([key]) => key !== "digest")
  );
  assert.throws(
    () => alembic.verifyPlan({
      ...changedGraphUnsigned,
      digest: alembic.sha256(alembic.canonicalJson(changedGraphUnsigned))
    }),
    /trust evidence differs/u
  );

  const componentLockPath = join(root, "node_modules", "@gnolith", "seedbed", "seedbed-component-lock.json");
  const componentLock = await readFile(componentLockPath);
  const tampered = JSON.parse(componentLock.toString("utf8"));
  tampered.localBuildSelector = "gnolith-seedbed-local-build-v2";
  await writeFile(componentLockPath, JSON.stringify(tampered));
  await assert.rejects(alembic.attestInstalledSeedbed(), /component lock differs/u);
  await writeFile(componentLockPath, componentLock);
  await alembic.attestInstalledSeedbed();

  const child = spawn(process.execPath, [join(alembicRoot, "dist", "mcp.js")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...chunk.trim().split(/\r?\n/u).filter(Boolean)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  await delay(250);
  child.kill();
  const listed = lines.map((line) => JSON.parse(line)).find((message) => message.id === 2);
  assert.equal(listed.result.tools.length, 9);
  assert.equal(listed.result.tools.some(({ name }) => name.startsWith("gnolith_")), false);
  assert.equal(fetchCalls, 0);
  process.stdout.write("packed exact Alembic+Seedbed semantic plan/apply/repair, final Workshop-52 verification, no-pull, and nine-tool Alembic smoke passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
