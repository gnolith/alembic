import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const npmCommand = process.env.npm_execpath ? process.execPath : "npm";
const npmPrefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];
const root = new URL("../", import.meta.url);
const destination = await mkdtemp(join(tmpdir(), "alembic-install-gate-"));

try {
  const { stdout } = await exec(
    npmCommand,
    [...npmPrefix, "pack", "--json", "--pack-destination", destination],
    { cwd: root, maxBuffer: 20 * 1024 * 1024 }
  );
  const packed = JSON.parse(stdout);
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error("Fresh-install gate expected exactly one Alembic archive");
  }
  await exec(
    process.execPath,
    [
      fileURLToPath(new URL("./packed-install-proof.mjs", import.meta.url)),
      join(destination, packed[0].filename)
    ],
    { cwd: root, maxBuffer: 20 * 1024 * 1024 }
  );
} finally {
  await rm(destination, { recursive: true, force: true });
}
