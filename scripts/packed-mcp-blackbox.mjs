import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [alembicArchive, seedbedArchive, workshopArchive, legacyFixture] = process.argv.slice(2);
if (!alembicArchive || !seedbedArchive || !workshopArchive) {
  throw new Error("Exact Alembic, Seedbed, and Workshop archives are required");
}

const root = await mkdtemp(join(tmpdir(), "alembic-packed-mcp-"));
const projectRoot = join(root, "project");
const stateRoot = join(root, "seedbed-state");
await Promise.all([
  mkdir(projectRoot, { recursive: true }),
  mkdir(stateRoot, { recursive: true })
]);

let child;
try {
  const npmCli = process.env.npm_execpath ??
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await exec(process.execPath, [
    npmCli,
    "install",
    "--prefix",
    root,
    "--ignore-scripts",
    "--package-lock=false",
    "--legacy-peer-deps",
    alembicArchive,
    seedbedArchive,
    workshopArchive
  ], { maxBuffer: 20 * 1024 * 1024 });
  const alembicRoot = join(root, "node_modules", "@gnolith", "alembic");
  const api = await import(pathToFileURL(join(alembicRoot, "dist", "index.js")).href);
  const configPath = join(projectRoot, ".codex", "config.toml");
  const config = "[mcp_servers.other]\nurl = \"https://other.example/mcp\"\n";
  const validLegacyPath = join(projectRoot, "valid-legacy.json");
  const invalidLegacyPath = join(projectRoot, "invalid-legacy.snapshot");

  child = spawn(process.execPath, [
    join(alembicRoot, "dist", "mcp.js")
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      GNOLITH_BEARER_TOKEN: undefined
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const rpc = jsonRpcClient(child);
  const initialized = await rpc.call("initialize", {}, 3_000);
  assert.equal(initialized.serverInfo.name, "alembic");
  const listed = await rpc.call("tools/list", {}, 3_000);
  assert.equal(listed.tools.length, 9);
  assert.equal(listed.tools.some(({ name }) => name.startsWith("gnolith_")), false);
  const inspected = await rpc.tool("alembic_inspect", {
    taskDirectory: projectRoot,
    confirmedProjectRoot: projectRoot
  }, 3_000);
  assert.equal(inspected.purpose, "setup-and-diagnostics-only");

  const expected = {
    installationId: "final2-9d61c3",
    baseIri: "https://acceptance.invalid/urban-birdwatching/",
    serverVersion: "0.5.0",
    operationVersion: "2",
    catalogDigest: "af455b4d6ab3560bca9c0ab48e9db7bd3cbcfa166ace875578d88d182069071f",
    migrationReady: true,
    canonicalReady: true,
    authorizationReady: true,
    lexicalReady: true,
    blobReady: true,
    producerStatus: "ready",
    semanticState: "absent",
    allowLexicalOnly: true
  };
  const docker = {
    installationId: expected.installationId,
    baseIri: expected.baseIri,
    endpoint: "http://127.0.0.1:45411/mcp",
    image: {
      kind: "seedbed-local-build-v1",
      selector: "gnolith-seedbed-local-build-v1",
      pullPolicy: "never",
      componentLockSha256: "4bf9259d44495372f70420f5e235b3e12319c5f8be2a8cfff5961a9c89331bfc",
      graphSha256: "9cffdfffa8eb8ae1e961b0b88571c9e6476a7427dcdbd018698e793297ba5be1",
      composeBundleSha256: "f25e9e651de83e94ed6d1d5a25bc2446209951400a8190f50726f2c555f4fdb9"
    },
    expected
  };
  const request = {
    taskDirectory: projectRoot,
    confirmedProjectRoot: projectRoot,
    action: "create",
    mode: "docker-local",
    endpoint: docker.endpoint,
    authentication: { kind: "environment", variable: "GNOLITH_BEARER_TOKEN" },
    acceptLexicalOnly: true,
    expected,
    docker
  };
  const defaultStatePlan = await rpc.tool("alembic_plan", { request }, 20_000);
  assert.equal(defaultStatePlan.expected.operationVersion, "2");
  assert.equal(defaultStatePlan.seedbedPlan.request.expected.operationVersion, "11");
  const slashPlan = await rpc.tool("alembic_plan", {
    request: { ...request, seedbedStateRoot: stateRoot }
  }, 20_000);
  assert.equal(slashPlan.expected.baseIri, "https://acceptance.invalid/urban-birdwatching");
  assert.equal(slashPlan.expected.operationVersion, "2");
  assert.equal(slashPlan.seedbedPlan.request.expected.operationVersion, "11");
  const canonicalPlan = await rpc.tool("alembic_plan", {
    request: {
      ...request,
      seedbedStateRoot: stateRoot,
      expected: { ...expected, baseIri: "https://acceptance.invalid/urban-birdwatching" },
      docker: {
        ...docker,
        baseIri: "https://acceptance.invalid/urban-birdwatching",
        expected: { ...expected, baseIri: "https://acceptance.invalid/urban-birdwatching" }
      }
    }
  }, 20_000);
  assert.equal(canonicalPlan.requestDigest, slashPlan.requestDigest);
  assert.equal(slashPlan.endpoint, "http://127.0.0.1:45411/mcp");
  assert.doesNotMatch(JSON.stringify(slashPlan), /stdio|process-local/iu);
  await assert.rejects(readFile(configPath, "utf8"), /ENOENT/u);
  assert.equal((await readdir(join(projectRoot, ".codex", "alembic", "plans"))).length, 3);
  const invalidStartedAt = Date.now();
  const invalid = await rpc.envelope("tools/call", {
    name: "alembic_plan",
    arguments: {
      request: {
        ...request,
        seedbedStateRoot: stateRoot,
        acceptLexicalOnly: false,
        expected: { ...expected, allowLexicalOnly: false },
        docker: {
          ...docker,
          expected: { ...expected, allowLexicalOnly: false }
        }
      }
    }
  }, 5_000, "invalid-final-prompt");
  assert.equal(invalid.id, "invalid-final-prompt");
  assert.equal(invalid.error?.data?.classification, "seedbed-control-rejected");
  assert.equal(invalid.error?.data?.stage, "plan-seedbed-control");
  assert.equal(invalid.error?.data?.seedbed?.upstream?.code, "seedbed-request-lexical-acceptance");
  assert.equal(Date.now() - invalidStartedAt < 5_000, true);
  const afterFailure = await rpc.tool("alembic_inspect", {
    taskDirectory: projectRoot,
    confirmedProjectRoot: projectRoot
  }, 3_000);
  assert.equal(afterFailure.purpose, "setup-and-diagnostics-only");

  await mkdir(join(projectRoot, ".codex"), { recursive: true });
  await writeFile(configPath, config);
  const unsignedLegacy = {
    format: "gnolith-setup-to-alembic-v1",
    schemaVersion: 1,
    projectRoot,
    configDigest: api.sha256(config),
    legacyMarkerDigest: null,
    marker: {
      begin: "# BEGIN ALEMBIC MANAGED GNOLITH MCP",
      end: "# END ALEMBIC MANAGED GNOLITH MCP",
      state: "absent"
    },
    connection: {
      mode: "remote-http",
      endpoint: "https://example.com/mcp",
      authentication: { kind: "oauth" }
    },
    receipts: []
  };
  await writeFile(validLegacyPath, JSON.stringify({
    ...unsignedLegacy,
    sha256: api.sha256(api.canonicalJson(unsignedLegacy))
  }));
  if (legacyFixture) await copyFile(legacyFixture, invalidLegacyPath);
  else await writeFile(invalidLegacyPath, new Uint8Array([0x1f, 0x8b, 0x08, 0x00]));

  const legacy = await rpc.tool("alembic_legacy_inspect", {
    bundlePath: validLegacyPath,
    taskDirectory: projectRoot,
    confirmedProjectRoot: projectRoot,
    packageName: "@gnolith/codex-plugin",
    packageVersion: "0.2.0"
  }, 8_000);
  assert.equal(legacy.disposition, "remote-verify");
  await assert.rejects(
    rpc.tool("alembic_legacy_inspect", {
      bundlePath: invalidLegacyPath,
      taskDirectory: projectRoot,
      confirmedProjectRoot: projectRoot,
      packageName: "@gnolith/codex-plugin",
      packageVersion: "0.2.0"
    }, 8_000),
    /legacy-json-format/u
  );
} finally {
  if (child && child.exitCode === null) {
    await stopChild(child);
  }
  await rm(root, { recursive: true, force: true });
}

async function stopChild(processHandle) {
  let exited = false;
  const exit = new Promise((resolve) => processHandle.once("exit", () => {
    exited = true;
    resolve();
  }));
  processHandle.kill();
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (exited) return;
  if (process.platform === "win32" && processHandle.pid !== undefined) {
    await exec("taskkill.exe", ["/PID", String(processHandle.pid), "/T", "/F"]).catch(() => undefined);
  } else {
    processHandle.kill("SIGKILL");
  }
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

function jsonRpcClient(processHandle) {
  let nextId = 1;
  let stdout = "";
  let stderr = "";
  const pending = new Map();
  processHandle.stdout.setEncoding("utf8");
  processHandle.stderr.setEncoding("utf8");
  processHandle.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  processHandle.stdout.on("data", (chunk) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const index = stdout.indexOf("\n");
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line);
      const waiting = pending.get(message.id);
      if (!waiting) continue;
      pending.delete(message.id);
      if (waiting.envelope) {
        waiting.resolve(message);
        continue;
      }
      if (message.error) waiting.reject(new Error(
        `${message.error.data?.classification ?? "rpc"}: ${message.error.message}; data=${JSON.stringify(message.error.data ?? {})}; stderr=${stderr}`
      ));
      else waiting.resolve(message.result);
    }
  });
  const call = (method, params, timeoutMs) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} exceeded ${timeoutMs}ms; stderr=${stderr}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      processHandle.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  return {
    call,
    envelope(method, params, timeoutMs, id) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} exceeded ${timeoutMs}ms; stderr=${stderr}`));
        }, timeoutMs);
        pending.set(id, {
          envelope: true,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject
        });
        processHandle.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async tool(name, args, timeoutMs) {
      const result = await call("tools/call", { name, arguments: args }, timeoutMs);
      if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
      return result.structuredContent;
    }
  };
}
