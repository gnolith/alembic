import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

async function filesUnder(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path));
    else output.push(path);
  }
  return output;
}

test("source has no arbitrary execution, database, query, Compose, deployment, or proxy implementation", async () => {
  const source = await filesUnder(join(root, "src"));
  const body = (await Promise.all(source.map((path) => readFile(path, "utf8")))).join("\n");
  for (const denied of [
    /child_process/u,
    /\bexecFile\b/u,
    /\bspawn\s*\(/u,
    /\b(?:postgres|sparql)\b/iu,
    /from\s+["'][^"']*(?:sqlite|qdrant)/iu,
    /docker compose/iu,
    /cloudflare/iu,
    /hosting\.json/iu
  ]) {
    assert.doesNotMatch(body, denied);
  }
  assert.match(body, /name: "gnolith_status"/u);
  const workshop = await readFile(join(root, "src", "workshop.ts"), "utf8");
  assert.doesNotMatch(workshop, /name:\s*(?:input|request|args|toolName)\b/u);
});

test("secret canary is absent from public artifacts and serialized source fixtures", async () => {
  const canary = "ALEMBIC_SECRET_CANARY_DO_NOT_SERIALIZE_7xf92";
  const files = [
    ...await filesUnder(join(root, "src")),
    ...await filesUnder(join(root, "plugin")),
    ...await filesUnder(join(root, "schemas")),
    ...await filesUnder(join(root, ".github"))
  ];
  for (const path of files) {
    assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(canary, "u"));
  }
});

test("workflows have least privilege and no hosted provisioning", async () => {
  const workflows = await filesUnder(join(root, ".github", "workflows"));
  for (const path of workflows) {
    const body = await readFile(path, "utf8");
    assert.doesNotMatch(body, /permissions:\s*write-all/iu);
    assert.doesNotMatch(body, /\b(?:cloudflare|codex sites|deploy)\b/iu);
    for (const action of body.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/gu)) {
      assert.match(action[2]!, /^[0-9a-f]{40}$/u, `${action[1]} must be pinned to an immutable commit`);
    }
  }
});

test("public release is trusted-publisher only and package bundles exact Seedbed runtime", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    publishConfig: { access: string; provenance: boolean };
    dependencies: Record<string, string>;
    bundleDependencies: string[];
    peerDependencies?: Record<string, string>;
  };
  assert.deepEqual(manifest.publishConfig, { access: "public", provenance: true });
  assert.equal(manifest.dependencies["@gnolith/seedbed"], "0.4.0");
  assert.deepEqual(manifest.bundleDependencies, ["@gnolith/seedbed"]);
  assert.equal(manifest.peerDependencies?.["@gnolith/seedbed"], undefined);
  const candidateLock = JSON.parse(await readFile(join(root, "candidate-lock.json"), "utf8")) as {
    seedbed: { sha256: string };
  };
  const bundledSeedbed = await readFile(join(root, "vendor", "gnolith-seedbed-0.4.0.tgz"));
  assert.equal(createHash("sha256").update(bundledSeedbed).digest("hex"), candidateLock.seedbed.sha256);
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; resolved?: string; inBundle?: boolean }>;
  };
  assert.equal(lock.packages["node_modules/@gnolith/seedbed"]?.version, "0.4.0");
  assert.equal(lock.packages["node_modules/@gnolith/seedbed"]?.resolved, "file:vendor/gnolith-seedbed-0.4.0.tgz");
  assert.equal(lock.packages["node_modules/@gnolith/seedbed"]?.inBundle, true);

  const release = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(release, /id-token:\s*write/u);
  assert.match(release, /npm publish --access public --provenance/u);
  assert.doesNotMatch(release, /NODE_AUTH_TOKEN|NPM_TOKEN|npm_[A-Za-z0-9_-]*token/iu);
});
