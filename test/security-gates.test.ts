import test from "node:test";
import assert from "node:assert/strict";
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
    /\b(?:postgres|sqlite|qdrant|sparql)\b/iu,
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
  }
});
