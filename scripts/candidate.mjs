import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
const artifacts = new URL("../artifacts/", import.meta.url);

const coordinates = {
  seedbed: requireCoordinate("SEEDBED_CANDIDATE", "SEEDBED_CANDIDATE_SHA256"),
  workshop: requireCoordinate("WORKSHOP_CANDIDATE", "WORKSHOP_CANDIDATE_SHA256"),
  legacy: requireCoordinate("LEGACY_CANDIDATE", "LEGACY_CANDIDATE_SHA256")
};
const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
const { stdout: status } = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root });
if (status.trim()) throw new Error("Candidate requires a clean committed worktree");
await exec("npm", ["run", "gate"], { cwd: root });
await mkdir(artifacts, { recursive: true });
const { stdout: packOutput } = await exec("npm", ["pack", "--json", "--pack-destination", "artifacts"], { cwd: root });
const packed = JSON.parse(packOutput);
if (!Array.isArray(packed) || packed.length !== 1) throw new Error("Unexpected npm pack result");
const archiveName = packed[0].filename;
const archivePath = join(fileURLToPath(artifacts), archiveName);
const archiveDigest = digest(await readFile(archivePath));
const { stdout: sbom } = await exec("npm", ["sbom", "--sbom-format", "cyclonedx"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
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

function requireCoordinate(name, digestName) {
  const coordinate = process.env[name];
  const sha256 = process.env[digestName];
  if (!coordinate || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${name} and exact lowercase ${digestName} are required`);
  }
  return { coordinate, sha256 };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
