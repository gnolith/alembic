import { readFile } from "node:fs/promises";
import { canonicalDirectory, canonicalJson, sha256 } from "./canonical.js";
import {
  BEGIN_MARKER,
  END_MARKER,
  type LegacyHandoffBundle,
  type LegacyLocalAdoptionReceipt,
  type LegacyReceipt
} from "./types.js";
import { invariant } from "./errors.js";

const MAX_BUNDLE = 1_048_576;
const BUNDLE_KEYS = [
  "format",
  "schemaVersion",
  "projectRoot",
  "configDigest",
  "legacyMarkerDigest",
  "marker",
  "connection",
  "receipts",
  "sha256"
];
const RECEIPT_KEYS = [
  "format",
  "operationId",
  "planId",
  "state",
  "method",
  "action",
  "startedAt",
  "updatedAt",
  "completedSteps",
  "expectedInstallationId",
  "expectedBaseIri"
];

function exactKeys(value: object, expected: readonly string[], label: string): void {
  invariant(
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()),
    "legacy-extra-keys",
    `${label} does not have the exact schema keys`
  );
}

function validIdentifier(value: string): boolean {
  return [...value.normalize("NFC")].length <= 256 && value === value.normalize("NFC") && value.length > 0;
}

function canonicalTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validateReceipt(receipt: LegacyReceipt): void {
  exactKeys(receipt, RECEIPT_KEYS, "Legacy receipt");
  invariant(receipt.format === "gnolith-setup-operation-v1", "legacy-receipt-format", "Unsupported legacy receipt format");
  invariant(["applying", "failed", "activation-required", "complete"].includes(receipt.state),
    "legacy-receipt-state", "Unsupported legacy receipt state");
  invariant(["process", "docker", "remote-http", "codex-sites"].includes(receipt.method),
    "legacy-receipt-method", "Unsupported legacy receipt method");
  invariant(["create", "connect"].includes(receipt.action), "legacy-receipt-action", "Unsupported legacy receipt action");
  invariant(validIdentifier(receipt.operationId) && validIdentifier(receipt.planId),
    "legacy-identifier", "Legacy receipt identifier is invalid");
  invariant(canonicalTimestamp(receipt.startedAt) && canonicalTimestamp(receipt.updatedAt),
    "legacy-timestamp", "Legacy receipt timestamps must be canonical UTC");
  invariant(receipt.completedSteps.every(validIdentifier), "legacy-step", "Legacy completed step is invalid");
  for (const value of [receipt.expectedInstallationId, receipt.expectedBaseIri]) {
    invariant(value === null || validIdentifier(value), "legacy-identifier", "Legacy expected identity is invalid");
  }
}

export async function inspectLegacyBundle(input: {
  bytes: Uint8Array;
  packageName: string;
  packageVersion: string;
  exactTaskRoot: string;
  configPath: string;
}): Promise<{
  bundle: LegacyHandoffBundle;
  disposition: "remote-verify" | "seedbed-offline-adoption-required" | "replan-required";
}> {
  invariant(input.packageName === "@gnolith/codex-plugin" && input.packageVersion === "0.2.0",
    "legacy-package-version", "Only @gnolith/codex-plugin@0.2.0 is accepted");
  invariant(input.bytes.byteLength <= MAX_BUNDLE, "legacy-bundle-too-large", "Legacy bundle exceeds 1 MiB");
  const raw = Buffer.from(input.bytes).toString("utf8");
  invariant(!raw.includes("\uFFFD"), "legacy-utf8", "Legacy bundle is not valid UTF-8");
  const bundle = JSON.parse(raw) as LegacyHandoffBundle;
  invariant(bundle && typeof bundle === "object" && !Array.isArray(bundle), "legacy-schema", "Legacy bundle must be an object");
  exactKeys(bundle, BUNDLE_KEYS, "Legacy bundle");
  invariant(bundle.format === "gnolith-setup-to-alembic-v1" && bundle.schemaVersion === 1,
    "legacy-format", "Unsupported legacy handoff schema");
  exactKeys(bundle.marker, ["begin", "end", "state"], "Legacy marker");
  invariant(["absent", "complete", "invalid", "user-owned"].includes(bundle.marker.state),
    "legacy-marker-state", "Unsupported legacy marker state");
  invariant(bundle.marker.begin === BEGIN_MARKER && bundle.marker.end === END_MARKER,
    "legacy-markers", "Legacy marker strings are not exact");
  invariant(bundle.marker.state !== "invalid" && bundle.marker.state !== "user-owned",
    "legacy-marker-conflict", "Legacy marker is malformed or user-owned");
  invariant(bundle.receipts.length <= 1000, "legacy-receipt-bound", "Legacy bundle has more than 1,000 receipts");
  bundle.receipts.forEach(validateReceipt);
  invariant(
    bundle.receipts.every((receipt, index) => index === 0 || bundle.receipts[index - 1]!.operationId < receipt.operationId),
    "legacy-receipt-order",
    "Legacy receipts must be strictly sorted by operationId"
  );
  const { sha256: suppliedDigest, ...unsigned } = bundle;
  invariant(/^[0-9a-f]{64}$/u.test(suppliedDigest), "legacy-digest-format", "Legacy bundle digest is not lowercase SHA-256");
  invariant(sha256(canonicalJson(unsigned)) === suppliedDigest, "legacy-digest", "Legacy bundle digest mismatch");
  if (bundle.connection) {
    exactKeys(bundle.connection, ["mode", "endpoint", "authentication"], "Legacy connection");
    exactKeys(bundle.connection.authentication, Object.keys(bundle.connection.authentication), "Legacy authentication");
    invariant(["process", "docker", "remote-http", "codex-sites", "unknown"].includes(bundle.connection.mode),
      "legacy-mode", "Unsupported legacy connection mode");
    invariant(["none", "bearer-environment", "oauth", "chatgpt"].includes(bundle.connection.authentication.kind),
      "legacy-auth", "Unsupported legacy authentication selector");
    if (bundle.connection.authentication.kind === "bearer-environment") {
      exactKeys(bundle.connection.authentication, ["kind", "variable"], "Legacy bearer selector");
      invariant(validIdentifier(bundle.connection.authentication.variable), "legacy-auth", "Legacy environment selector is invalid");
    } else {
      exactKeys(bundle.connection.authentication, ["kind"], "Legacy authentication");
    }
  }
  const taskRoot = await canonicalDirectory(input.exactTaskRoot);
  const bundleRoot = await canonicalDirectory(bundle.projectRoot);
  invariant(bundleRoot === bundle.projectRoot && bundleRoot === taskRoot,
    "legacy-project-moved", "Legacy bundle project root is not the exact canonical task root");
  const configBytes = await readFile(input.configPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  invariant(
    (configBytes === null ? null : sha256(configBytes)) === bundle.configDigest,
    "legacy-config-changed",
    "Project config differs from the legacy handoff"
  );
  if (bundle.marker.state === "complete") {
    invariant(configBytes !== null, "legacy-marker-missing", "Legacy marker config is missing");
    const normalized = configBytes.toString("utf8").replace(/\r\n?/gu, "\n");
    const begin = normalized.indexOf(BEGIN_MARKER);
    const end = normalized.indexOf(END_MARKER, begin);
    invariant(begin >= 0 && end > begin, "legacy-marker-missing", "Exact legacy marker block is absent");
    const inclusive = `${normalized.slice(begin, end + END_MARKER.length).replace(/\n*$/gu, "")}\n`;
    invariant(sha256(inclusive) === bundle.legacyMarkerDigest, "legacy-marker-digest", "Legacy marker digest mismatch");
  } else {
    invariant(bundle.legacyMarkerDigest === null, "legacy-marker-digest", "Absent marker must have null digest");
  }
  if (bundle.connection?.mode === "remote-http") {
    invariant(bundle.connection.endpoint !== null, "legacy-endpoint", "Legacy remote connection lacks endpoint");
    return { bundle, disposition: "remote-verify" };
  }
  if (bundle.connection?.mode === "process" || bundle.connection?.mode === "docker") {
    return { bundle, disposition: "seedbed-offline-adoption-required" };
  }
  return { bundle, disposition: "replan-required" };
}

export function verifyLegacyLocalAdoption(
  receipt: LegacyLocalAdoptionReceipt,
  expected: {
    installationId: string;
    baseIri: string;
    domainCount: number;
    payloadDigest: string;
    catalogDigest: string;
    ownerLedgerDigest: string;
  }
): void {
  invariant(receipt.format === "gnolith-seedbed-legacy-adoption-v1" && receipt.version === "0.1.0" && receipt.state === "ready",
    "legacy-offline-adoption", "Seedbed legacy-local-v1 adoption is not ready");
  for (const key of ["installationId", "baseIri", "domainCount", "payloadDigest", "catalogDigest", "ownerLedgerDigest"] as const) {
    invariant(receipt[key] === expected[key], "legacy-adoption-evidence", `Seedbed adoption evidence mismatch: ${key}`);
  }
}
