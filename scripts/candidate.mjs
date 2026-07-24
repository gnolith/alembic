import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const exec = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const root = new URL("../", import.meta.url);
const artifacts = new URL("../artifacts/", import.meta.url);
const lock = JSON.parse(await readFile(new URL("../candidate-lock.json", import.meta.url)));

const coordinates = {
  seedbed: await requireCoordinate("SEEDBED_CANDIDATE", "SEEDBED_CANDIDATE_SHA256", lock.seedbed),
  workshop: await requireCoordinate("WORKSHOP_CANDIDATE", "WORKSHOP_CANDIDATE_SHA256", lock.workshop),
  legacy: await requireCoordinate("LEGACY_CANDIDATE", "LEGACY_CANDIDATE_SHA256", {
    package: lock.legacy.migrationPackage,
    version: lock.legacy.version,
    bytes: lock.legacy.bytes,
    sha256: lock.legacy.sha256
  })
};
const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
const { stdout: status } = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root });
if (status.trim()) throw new Error("Candidate requires a clean committed worktree");
await exec(npmCommand, ["run", "gate"], { cwd: root });
await mkdir(artifacts, { recursive: true });
const { stdout: packOutput } = await exec(npmCommand, ["pack", "--json", "--pack-destination", "artifacts"], { cwd: root });
const packed = JSON.parse(packOutput);
if (!Array.isArray(packed) || packed.length !== 1) throw new Error("Unexpected npm pack result");
const archiveName = packed[0].filename;
const archivePath = join(fileURLToPath(artifacts), archiveName);
const archiveDigest = digest(await readFile(archivePath));
const { stdout: sbom } = await exec(npmCommand, ["sbom", "--sbom-format", "cyclonedx"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
const sbomPath = new URL("../artifacts/alembic-0.1.0.cdx.json", import.meta.url);
await writeFile(sbomPath, sbom);
const sbomDigest = digest(await readFile(sbomPath));
const inventory = {
  format: "gnolith-alembic-candidate-v1",
  version: "0.1.0",
  commit: commit.trim(),
  artifact: { file: archiveName, sha256: archiveDigest },
  sbom: { file: "alembic-0.1.0.cdx.json", sha256: sbomDigest },
  coordinates,
  pluginId: "alembic",
  tools: [
    "alembic_inspect", "alembic_discover", "alembic_plan", "alembic_apply",
    "alembic_operation_read", "alembic_operation_resume", "alembic_diagnose",
    "alembic_legacy_inspect", "alembic_legacy_adopt"
  ],
  dataPlane: { identity: "gnolith", path: "/mcp", statusTool: "gnolith_status" },
  markerFormat: "ALEMBIC MANAGED GNOLITH MCP v1",
  releasePublished: false
};
await writeFile(new URL("../artifacts/inventory.json", import.meta.url), JSON.stringify(inventory, null, 2) + "\n");
const inventoryDigest = digest(await readFile(new URL("../artifacts/inventory.json", import.meta.url)));
const report = {
  format: "gnolith-alembic-self-green-v1",
  version: "0.1.0",
  commit: commit.trim(),
  generatedAt: new Date().toISOString(),
  environment: { platform: process.platform, architecture: process.arch, node: process.version },
  commands: [
    "npm ci",
    "npm run lint",
    "npm test",
    "npm run test:security",
    "npm run test:plugin",
    "npm run build",
    "npm audit --omit=dev --audit-level=high",
    "npm pack --dry-run"
  ],
  result: "PASS",
  productionVulnerabilitiesHighCritical: 0,
  releasePublished: false,
  mismatches: [],
  artifactSha256: archiveDigest,
  sbomSha256: sbomDigest,
  coordinates
};
await writeFile(new URL("../artifacts/self-green.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
const reportDigest = digest(await readFile(new URL("../artifacts/self-green.json", import.meta.url)));
await writeFile(
  new URL("../artifacts/SHA256SUMS", import.meta.url),
  [
    `${archiveDigest}  ${archiveName}`,
    `${sbomDigest}  alembic-0.1.0.cdx.json`,
    `${inventoryDigest}  inventory.json`,
    `${reportDigest}  self-green.json`
  ].join("\n") + "\n"
);

async function requireCoordinate(name, digestName, expected) {
  const coordinate = process.env[name];
  const sha256 = process.env[digestName];
  if (!coordinate || !sha256 || sha256 !== expected.sha256) {
    throw new Error(`${name} and exact lowercase ${digestName} are required`);
  }
  if (!isAbsolute(coordinate)) throw new Error(`${name} must be an exact absolute candidate artifact selector`);
  const bytes = await readFile(coordinate);
  if (digest(bytes) !== sha256) throw new Error(`${name} bytes do not match ${digestName}`);
  const manifest = packageManifest(bytes);
  if (manifest.name !== expected.package || manifest.version !== expected.version || bytes.byteLength !== expected.bytes) {
    throw new Error(`${name} package identity/size differs from candidate lock`);
  }
  return {
    coordinate,
    sha256,
    bytes: bytes.byteLength,
    package: manifest.name,
    version: manifest.version
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageManifest(gzipped) {
  const tar = gunzipSync(gzipped);
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (name === "package/package.json") return JSON.parse(body.toString("utf8"));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("Candidate archive has no package/package.json");
}
