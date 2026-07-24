import { canonicalJson, operationId, planId, sha256 } from "./canonical.js";
import { approveEndpoint } from "./endpoint.js";
import { invariant } from "./errors.js";
import { attestProject } from "./project.js";
import { OperationStore } from "./store.js";
import { verifyLegacyLocalAdoption } from "./legacy.js";
import {
  isDigestQualifiedImage,
  SEEDBED_LOCAL_BUILD_SELECTION,
  SEEDBED_LOCAL_BUILD_TRUST,
  verifySeedbedLocalBuildTrust
} from "./seedbed-trust.js";
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
  seedbed: "@gnolith/seedbed@0.4.0",
  workshop: "@gnolith/workshop@0.5.0",
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
    invariant(
      seedbedPlan.version === "gnolith-seedbed-control-plan-v2",
      "seedbed-version-mismatch",
      "Seedbed control-plan contract is incompatible"
    );
    invariant(
      canonicalJson(normalized.docker.image) === canonicalJson(SEEDBED_LOCAL_BUILD_SELECTION) &&
        canonicalJson(seedbedPlan.request.image) === canonicalJson(SEEDBED_LOCAL_BUILD_SELECTION),
      "seedbed-local-build-selector-mismatch",
      "Seedbed plan must use the exact pinned local-build selector"
    );
    invariant(
      canonicalJson(seedbedPlan.request) === canonicalJson(normalized.docker),
      "seedbed-plan-request-mismatch",
      "Seedbed plan changed the approved Docker-local request"
    );
    invariant(/^[0-9a-f]{64}$/u.test(seedbedPlan.digest), "seedbed-plan-digest", "Seedbed plan digest is invalid");
    invariant(
      seedbedPlan.stateRoot.kind === "external-directory" &&
        seedbedPlan.stateRoot.canonicalPath.length > 0,
      "seedbed-state-root",
      "Seedbed plan lacks its attested opaque external state selector"
    );
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
    seedbedLocalBuildTrust: seedbedPlan === null ? null : SEEDBED_LOCAL_BUILD_TRUST,
    seedbedStateRoot: normalized.seedbedStateRoot ?? null,
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
  if (plan.seedbedPlan !== null) {
    invariant(
      canonicalJson(plan.seedbedPlan.request.image) === canonicalJson(SEEDBED_LOCAL_BUILD_SELECTION),
      "seedbed-local-build-selector-mismatch",
      "Seedbed plan selector differs from the pinned local build"
    );
    invariant(
      plan.seedbedLocalBuildTrust !== null,
      "seedbed-local-build-trust-missing",
      "Seedbed local-build trust evidence is absent"
    );
    verifySeedbedLocalBuildTrust(plan.seedbedLocalBuildTrust);
  } else {
    invariant(
      plan.seedbedLocalBuildTrust === null,
      "seedbed-local-build-trust-unexpected",
      "Seedbed local-build trust evidence is not applicable"
    );
  }
}

function validatePlanRequest(request: PlanRequest): void {
  exactAllowedKeys(request, [
    "taskDirectory", "confirmedProjectRoot", "hostMetadata", "action", "mode", "endpoint",
    "authentication", "expected", "docker", "acceptLexicalOnly", "legacyAdoption",
    "legacyEvidence", "legacyHandoff", "seedbedStateRoot"
  ], "plan request");
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
  if (request.authentication.kind === "environment") {
    exactAllowedKeys(request.authentication, ["kind", "variable"], "environment selector");
  } else {
    exactAllowedKeys(request.authentication, ["kind", "profile", "issuer", "audience", "scopes"], "OAuth selector");
    const issuer = new URL(request.authentication.issuer);
    invariant(
      issuer.protocol === "https:" && issuer.username === "" && issuer.password === "",
      "oauth-issuer-denied",
      "OAuth issuer must be credential-free HTTPS"
    );
    invariant(validIdentifier(request.authentication.audience), "oauth-audience", "OAuth audience is invalid");
    invariant(
      request.authentication.scopes.length > 0 &&
        request.authentication.scopes.length <= 32 &&
        request.authentication.scopes.every(validIdentifier) &&
        new Set(request.authentication.scopes).size === request.authentication.scopes.length,
      "oauth-scopes",
      "OAuth scopes are invalid or ambiguous"
    );
  }
  exactAllowedKeys(request.expected, [
    "installationId", "baseIri", "serverVersion", "operationVersion", "catalogDigest",
    "migrationReady", "canonicalReady", "authorizationReady", "lexicalReady",
    "blobReady", "producerStatus", "semanticState", "allowLexicalOnly"
  ], "expected Workshop status");
  invariant(validIdentifier(request.expected.installationId), "expected-identity-required", "Expected installation ID is invalid");
  invariant(validAbsoluteIri(request.expected.baseIri), "expected-base-required", "Expected base IRI is invalid");
  invariant(request.expected.catalogDigest.length === 64, "catalog-digest-required", "Expected catalog digest is required");
  invariant(/^[0-9a-f]{64}$/u.test(request.expected.catalogDigest), "catalog-digest-required", "Expected catalog digest must be lowercase SHA-256");
  for (const value of [request.expected.serverVersion, request.expected.operationVersion]) {
    invariant(validIdentifier(value), "expected-version", "Expected version evidence is invalid");
  }
  if (request.docker) {
    exactAllowedKeys(request.docker, ["installationId", "baseIri", "endpoint", "image", "expected"], "Docker request");
    exactAllowedKeys(
      request.docker.image,
      request.docker.image.kind === "seedbed-local-build-v1"
        ? ["kind", "selector", "pullPolicy", "componentLockSha256", "graphSha256", "composeBundleSha256"]
        : ["kind", "reference", "pullPolicy"],
      "Docker image selection"
    );
    exactAllowedKeys(request.docker.expected, [
      "installationId", "baseIri", "serverVersion", "operationVersion", "catalogDigest",
      "migrationReady", "canonicalReady", "authorizationReady", "lexicalReady",
      "blobReady", "producerStatus", "semanticState", "allowLexicalOnly"
    ], "Docker expected Workshop status");
    invariant(
      canonicalJson(request.docker.expected) === canonicalJson(request.expected),
      "docker-expected-mismatch",
      "Docker and Alembic expected Workshop evidence differ"
    );
    invariant(
      (request.docker.image.kind === "seedbed-local-build-v1" &&
        canonicalJson(request.docker.image) === canonicalJson(SEEDBED_LOCAL_BUILD_SELECTION)) ||
      (request.docker.image.kind === "digest-qualified-pulled-image-v1" &&
        request.docker.image.pullPolicy === "digest-only" &&
        isDigestQualifiedImage(request.docker.image.reference)),
      "unpinned-image",
      "Docker-local requires the exact attested Seedbed local build or a digest-qualified pulled image"
    );
  }
  if (request.action === "adopt") {
    invariant(request.legacyHandoff !== undefined, "legacy-handoff-required", "Adoption requires the exact inspected legacy handoff binding");
  }
  if (request.hostMetadata) {
    exactAllowedKeys(request.hostMetadata, ["version", "taskDirectory", "projectRoot", "trusted", "managedPolicy"], "host metadata");
  }
  if (request.legacyHandoff) {
    exactAllowedKeys(request.legacyHandoff, ["bundleDigest", "operationIds"], "legacy handoff binding");
  }
  if (request.legacyEvidence) {
    exactAllowedKeys(request.legacyEvidence, [
      "installationId", "baseIri", "domainCount", "payloadDigest", "catalogDigest", "ownerLedgerDigest"
    ], "legacy evidence");
  }
  if (request.legacyAdoption) {
    exactAllowedKeys(request.legacyAdoption, [
      "format", "version", "operationId", "state", "installationId", "baseIri", "domainCount",
      "payloadDigest", "catalogDigest", "ownerLedgerDigest", "protectedTokenFile"
    ], "legacy adoption receipt");
    exactAllowedKeys(
      request.legacyAdoption.protectedTokenFile,
      ["kind", "canonicalPath", "credentialId", "sha256"],
      "protected credential selector"
    );
  }
}

function exactAllowedKeys(value: object, allowed: readonly string[], label: string): void {
  invariant(
    Object.keys(value).every((key) => allowed.includes(key)),
    "unapproved-input",
    `${label} contains an unapproved field`
  );
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value === value.normalize("NFC") && [...value].length <= 256;
}

function validAbsoluteIri(value: string): boolean {
  try {
    const iri = new URL(value);
    return ["http:", "https:", "urn:"].includes(iri.protocol) && iri.username === "" && iri.password === "";
  } catch {
    return false;
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
    blobReady: request.expected.blobReady,
    producerStatus: request.expected.producerStatus,
    semanticState: request.expected.semanticState,
    allowLexicalOnly: request.acceptLexicalOnly === true
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
  if (request.seedbedStateRoot !== undefined) normalized.seedbedStateRoot = request.seedbedStateRoot;
  if (request.docker !== undefined) {
    normalized.docker = {
      installationId: request.docker.installationId,
      baseIri: request.docker.baseIri,
      endpoint: request.docker.endpoint,
      image: { ...request.docker.image },
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
