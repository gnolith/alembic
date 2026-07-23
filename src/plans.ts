import { canonicalJson, operationId, planId, sha256 } from "./canonical.js";
import { approveEndpoint } from "./endpoint.js";
import { invariant } from "./errors.js";
import { attestProject } from "./project.js";
import { OperationStore } from "./store.js";
import { verifyLegacyLocalAdoption } from "./legacy.js";
import {
  ALEMBIC_VERSION,
  LOCAL_BEARER_ENV,
  type AlembicPlan,
  type PlanRequest,
  type SeedbedControl
} from "./types.js";

const PLAN_LIFETIME_MS = 15 * 60 * 1000;
export const COMPATIBILITY = {
  alembic: ALEMBIC_VERSION,
  seedbed: "@gnolith/seedbed@0.1.0",
  workshop: "@gnolith/workshop@0.1.0",
  legacy: "@gnolith/codex-plugin@0.2.0"
} as const;

export async function createPlan(request: PlanRequest, seedbed?: SeedbedControl): Promise<AlembicPlan> {
  validatePlanRequest(request);
  const normalized = normalizeRequest(request);
  const project = await attestProject(request);
  const endpoint = await approveEndpoint(normalized.endpoint, normalized.mode);
  let seedbedPlan = null;
  if (normalized.mode === "docker-local" && normalized.action !== "remove" && normalized.action !== "adopt") {
    invariant(seedbed !== undefined, "seedbed-required", "Docker-local operations require Seedbed");
    invariant(normalized.docker !== undefined, "docker-request-required", "Docker installation request is required");
    invariant(normalized.docker.endpoint === endpoint.href.replace(/\/$/u, ""), "docker-endpoint-mismatch", "Seedbed endpoint differs from plan");
    seedbedPlan = await seedbed.plan(normalized.docker);
    invariant(seedbedPlan.version === "0.1.0", "seedbed-version-mismatch", "Seedbed plan version is incompatible");
    invariant(seedbedPlan.digest === sha256(canonicalJson(seedbedPlan.request)), "seedbed-plan-digest", "Seedbed plan digest is invalid");
  }
  if (normalized.action === "adopt" && normalized.mode === "docker-local") {
    invariant(normalized.legacyAdoption !== undefined && normalized.legacyEvidence !== undefined,
      "legacy-offline-adoption", "A successful Seedbed legacy-local-v1 receipt and expected evidence are required");
    verifyLegacyLocalAdoption(normalized.legacyAdoption, normalized.legacyEvidence);
  }
  const now = new Date();
  const unsigned = {
    format: "gnolith-alembic-plan-v1" as const,
    planId: planId(),
    operationId: operationId(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_LIFETIME_MS).toISOString(),
    requestDigest: sha256(canonicalJson(normalized)),
    project,
    action: normalized.action,
    mode: normalized.mode,
    endpoint: endpoint.href.replace(/\/$/u, ""),
    authentication: normalized.authentication,
    expected: { ...normalized.expected, allowLexicalOnly: normalized.acceptLexicalOnly === true },
    seedbedPlan,
    seedbedPlanDigest: seedbedPlan?.digest ?? null,
    legacyAdoption: normalized.legacyAdoption ?? null,
    legacyHandoff: normalized.legacyHandoff ?? null,
    compatibility: COMPATIBILITY,
    approvedSteps:
      normalized.action === "remove"
        ? ["verify unchanged project scope", "remove only Alembic-managed config block"]
        : [
            ...(normalized.mode === "docker-local" ? [
              normalized.action === "adopt"
                ? "consume exact successful Seedbed legacy-local-v1 receipt"
                : "invoke exact Seedbed plan"
            ] : []),
            "authenticate and initialize Workshop",
            "verify fixed catalog and gnolith_status",
            "atomically write one managed config block",
            "require activation in a new Codex task"
          ]
  };
  const plan: AlembicPlan = { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
  await new OperationStore(project.root).writePlan(plan);
  return plan;
}

export function verifyPlan(plan: AlembicPlan): void {
  const { digest, ...unsigned } = plan;
  invariant(plan.format === "gnolith-alembic-plan-v1", "plan-format", "Unsupported plan format");
  invariant(digest === sha256(canonicalJson(unsigned)), "plan-digest", "Plan digest mismatch");
  invariant(new Date(plan.expiresAt).getTime() > Date.now(), "plan-expired", "Plan has expired");
  invariant(plan.compatibility.alembic === ALEMBIC_VERSION, "plan-version", "Plan was made by another Alembic version");
}

function validatePlanRequest(request: PlanRequest): void {
  invariant(["create", "connect", "repair", "rebind", "remove", "adopt"].includes(request.action),
    "action-denied", "Unsupported action");
  invariant(["docker-local", "remote"].includes(request.mode), "mode-denied", "Unsupported deployment mode");
  if (request.mode === "remote") {
    invariant(request.action !== "create", "remote-create-denied", "Remote mode is connect-existing only");
    invariant(request.docker === undefined, "remote-provision-denied", "Remote mode cannot include provisioning");
    invariant(request.authentication.kind === "host-oauth", "remote-oauth-required", "Remote mode requires host-managed OAuth");
  } else {
    invariant(request.authentication.kind === "environment", "local-bearer-required", "Docker-local requires bearer environment selector");
    invariant(request.authentication.variable === LOCAL_BEARER_ENV, "local-selector-mismatch", "Docker-local selector must be GNOLITH_BEARER_TOKEN");
  }
  invariant(request.expected.installationId.length > 0, "expected-identity-required", "Expected installation ID is required");
  invariant(request.expected.baseIri.length > 0, "expected-base-required", "Expected base IRI is required");
  invariant(request.expected.catalogDigest.length === 64, "catalog-digest-required", "Expected catalog digest is required");
  if (request.action === "adopt") {
    invariant(request.legacyHandoff !== undefined, "legacy-handoff-required", "Adoption requires the exact inspected legacy handoff binding");
  }
}

function normalizeRequest(request: PlanRequest): PlanRequest {
  const authentication = request.authentication.kind === "environment"
    ? { kind: "environment" as const, variable: request.authentication.variable }
    : {
        kind: "host-oauth" as const,
        profile: request.authentication.profile,
        issuer: request.authentication.issuer,
        audience: request.authentication.audience,
        scopes: [...request.authentication.scopes]
      };
  const expected = {
    installationId: request.expected.installationId,
    baseIri: request.expected.baseIri,
    serverVersion: request.expected.serverVersion,
    operationVersion: request.expected.operationVersion,
    catalogDigest: request.expected.catalogDigest,
    migrationReady: request.expected.migrationReady,
    canonicalReady: request.expected.canonicalReady,
    authorizationReady: request.expected.authorizationReady,
    lexicalReady: request.expected.lexicalReady,
    producerStatus: request.expected.producerStatus,
    semanticState: request.expected.semanticState,
    allowLexicalOnly: request.expected.allowLexicalOnly
  };
  const normalized: PlanRequest = {
    taskDirectory: request.taskDirectory,
    action: request.action,
    mode: request.mode,
    endpoint: request.endpoint,
    authentication,
    expected
  };
  if (request.confirmedProjectRoot !== undefined) normalized.confirmedProjectRoot = request.confirmedProjectRoot;
  if (request.hostMetadata !== undefined) normalized.hostMetadata = { ...request.hostMetadata };
  if (request.acceptLexicalOnly !== undefined) normalized.acceptLexicalOnly = request.acceptLexicalOnly;
  if (request.docker !== undefined) {
    normalized.docker = {
      installationId: request.docker.installationId,
      baseIri: request.docker.baseIri,
      endpoint: request.docker.endpoint,
      image: request.docker.image,
      expected: { ...expected }
    };
  }
  if (request.legacyAdoption !== undefined) {
    normalized.legacyAdoption = {
      format: request.legacyAdoption.format,
      version: request.legacyAdoption.version,
      operationId: request.legacyAdoption.operationId,
      state: request.legacyAdoption.state,
      installationId: request.legacyAdoption.installationId,
      baseIri: request.legacyAdoption.baseIri,
      domainCount: request.legacyAdoption.domainCount,
      payloadDigest: request.legacyAdoption.payloadDigest,
      catalogDigest: request.legacyAdoption.catalogDigest,
      ownerLedgerDigest: request.legacyAdoption.ownerLedgerDigest,
      protectedTokenFile: { ...request.legacyAdoption.protectedTokenFile }
    };
  }
  if (request.legacyEvidence !== undefined) normalized.legacyEvidence = { ...request.legacyEvidence };
  if (request.legacyHandoff !== undefined) {
    invariant(/^[0-9a-f]{64}$/u.test(request.legacyHandoff.bundleDigest),
      "legacy-handoff-digest", "Legacy handoff digest is invalid");
    invariant(request.legacyHandoff.operationIds.length <= 1000,
      "legacy-operation-bound", "Legacy handoff has too many operation identifiers");
    normalized.legacyHandoff = {
      bundleDigest: request.legacyHandoff.bundleDigest,
      operationIds: [...request.legacyHandoff.operationIds]
    };
  }
  return normalized;
}
