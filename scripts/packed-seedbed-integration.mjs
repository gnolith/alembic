import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [alembicArchive, seedbedArchive] = process.argv.slice(2);
if (!alembicArchive || !seedbedArchive) throw new Error("Exact Alembic and Seedbed archives are required");
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
      seedbedArchive
    ],
    { maxBuffer: 20 * 1024 * 1024 }
  );
  const alembicRoot = join(root, "node_modules", "@gnolith", "alembic");
  const alembic = await import(pathToFileURL(join(alembicRoot, "dist", "index.js")).href);
  assert.equal(alembic.TOOL_NAMES.length, 9);
  assert.equal(new Set(alembic.TOOL_NAMES).size, 9);
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
  const expected = {
    installationId: "packed-integration",
    baseIri: "https://example.test/packed/",
    serverVersion: "0.5.0",
    operationVersion: "9",
    catalogDigest: "577cc1de501b0ae3556eb1d32e7dd516c70a09c5b6226d671cec312068fba3dd",
    migrationReady: true,
    canonicalReady: true,
    authorizationReady: true,
    lexicalReady: true,
    blobReady: true,
    producerStatus: "ready",
    semanticState: "ready",
    allowLexicalOnly: false
  };
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

  const token = "packed_exact_local_token";
  const tokenPath = join(stateRoot, "packed-token");
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(tokenPath, 0o600);
  process.env.GNOLITH_BEARER_TOKEN = token;
  const packedSeedbedReceipt = (plan) => ({
    operationId: plan.id,
    state: "ready",
    version: "0.4.0",
    digest: plan.digest,
    endpoint: plan.request.endpoint,
    installationId: plan.request.installationId,
    baseIri: plan.request.baseIri,
    expected: plan.request.expected,
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

  const workshopStatus = {
    installationId: expected.installationId,
    baseIri: expected.baseIri,
    principalId: "packed-principal",
    credentialId: "packed-credential",
    activeWorkspaceId: null,
    capabilities: ["gnolith:use"],
    authorizationRevision: 1,
    migrationReadiness: { namespace: "@gnolith/workshop", version: 1, ready: true },
    compatibility: { diamond: true, taproot: true },
    canonicalReady: true,
    authorizationReady: true,
    lexicalReady: true,
    semanticState: { state: "ready", configured: true },
    producers: { ready: true, fingerprint: "packed", kinds: ["task", "memory", "prompt"] },
    blobReady: true,
    versions: { server: "0.5.0", operationSchema: 9 },
    operationCatalogDigest: expected.catalogDigest
  };
  const workshopTransport = {
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
            result: { tools: [{ name: "gnolith_status" }, { name: "gnolith_read" }] }
          }
        };
      }
      return {
        response: {
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: workshopStatus }
        }
      };
    }
  };
  const receipt = await alembic.applyPlan(plan, { seedbed, workshopTransport });
  assert.equal(receipt.state, "activation-required");
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
  process.stdout.write("packed exact Alembic+Seedbed local selector, trust, no-pull, apply, and nine-tool smoke passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
