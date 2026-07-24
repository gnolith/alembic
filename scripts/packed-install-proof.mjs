import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const npmCommand = process.env.npm_execpath
  ? process.execPath
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const npmPrefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];
const archive = resolve(process.argv[2] ?? "");
assert.ok(archive, "Alembic package archive is required");
const root = await mkdtemp(join(tmpdir(), "alembic-fresh-install-"));
const project = join(root, "project");
const packageRoot = join(root, "node_modules", "@gnolith", "alembic");
const seedbedRoot = join(packageRoot, "node_modules", "@gnolith", "seedbed");

try {
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "alembic-packed-install-proof", private: true, type: "module" }) + "\n"
  );
  await exec(
    npmCommand,
    [
      ...npmPrefix,
      "install",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      archive
    ],
    { cwd: root, maxBuffer: 20 * 1024 * 1024 }
  );

  const alembicManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(alembicManifest.dependencies["@gnolith/seedbed"], "0.4.0");
  assert.deepEqual(alembicManifest.bundleDependencies, ["@gnolith/seedbed"]);

  const seedbedManifest = JSON.parse(await readFile(join(seedbedRoot, "package.json"), "utf8"));
  assert.equal(seedbedManifest.name, "@gnolith/seedbed");
  assert.equal(seedbedManifest.version, "0.4.0");
  const localControl = await import(pathToFileURL(join(seedbedRoot, "dist", "local-control.js")).href);
  assert.equal(typeof localControl.createDefaultSeedbedControl, "function");
  await mkdir(project);
  const control = localControl.createDefaultSeedbedControl({ projectRoot: project });
  for (const method of ["inspect", "plan", "apply", "resume", "diagnose"]) {
    assert.equal(typeof control[method], "function");
  }

  const lockBytes = await readFile(join(seedbedRoot, "seedbed-component-lock.json"));
  const candidateLock = JSON.parse(await readFile(join(packageRoot, "candidate-lock.json"), "utf8"));
  assert.equal(
    createHash("sha256").update(lockBytes).digest("hex"),
    candidateLock.seedbed.componentLockSha256
  );
  const { stdout: dependencyTree } = await exec(
    npmCommand,
    [
      ...npmPrefix,
      "ls",
      "@gnolith/seedbed",
      "--all",
      "--json"
    ],
    { cwd: root, maxBuffer: 20 * 1024 * 1024 }
  );
  const listed = JSON.parse(dependencyTree);
  assert.equal(listed.dependencies["@gnolith/alembic"].dependencies["@gnolith/seedbed"].version, "0.4.0");
  assert.equal(JSON.stringify(listed).match(/"@gnolith\/seedbed"/gu)?.length, 1);

  const smoke = `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, [${JSON.stringify(join(packageRoot, "dist", "mcp.js"))}], {
      stdio: ["pipe", "pipe", "inherit"]
    });
    let body = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { body += chunk; });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\\n");
    setTimeout(() => child.kill(), 500);
    await new Promise(resolve => child.on("close", resolve));
    const lines = body.trim().split(/\\r?\\n/u).map(line => JSON.parse(line));
    if (lines[0]?.result?.serverInfo?.name !== "alembic") throw new Error("fresh MCP identity mismatch");
    if (lines[1]?.result?.tools?.length !== 9) throw new Error("fresh MCP catalog mismatch");
  `;
  await writeFile(join(root, "remote-smoke.mjs"), smoke);
  await exec(process.execPath, [join(root, "remote-smoke.mjs")], {
    cwd: dirname(packageRoot),
    maxBuffer: 20 * 1024 * 1024
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
