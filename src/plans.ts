import { canonicalBaseIri, canonicalJson, operationId, planId, sha256 } from "./canonical.js";
import { isAbsolute, normalize, resolve } from "node:path";
import { approveEndpoint } from "./endpoint.js";
import { invariant } from "./errors.js";
import { attestProject } from "./project.js";
import { OperationStore } from "./store.js";
import { verifyLegacyLocalAdoption } from "./legacy.js";
import { boundedSeedbedCall, SEEDBED_PLAN_DEADLINE_MS } from "./seedbed-call.js";
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
  type SemanticConfigurationV1,
  type SemanticPlanProfileV1,
  type SeedbedSemanticConfigurationV1,
  type SeedbedControl,
  type WaystoneEvidenceV1
} from "./types.js";
import {
  WORKSHOP_MIGRATION_SCHEMA_VERSION,
  WORKSHOP_OPERATION_SCHEMA_VERSION
} from "./workshop.js";

const PLAN_LIFETIME_MS = 15 * 60 * 1000;
export const COMPATIBILITY = {
  alembic: ALEMBIC_VERSION,
  seedbed: "@gnolith/seedbed@0.4.0",
  workshop: "@gnolith/workshop@0.5.0",
  legacy: "@gnolith/codex-plugin@0.2.0"
} as const;
export const WAYSTONE_DEFAULT_EVIDENCE: WaystoneEvidenceV1 = {
  enabled: true,
  prefix: "/app",
  manifestSha256: "f341c3fe00d3a93d9af6ca379453c02eb02287fa486847a5cf0764f1fef87a65",
  entrypoint: {
    path: "assets/waystone.css",
    sha256: "6439decf9ad5245e1652da92d9547ad09e1a350ea97ab9b94fc6e6b632b66a7a",
    bytes: 16_162,
    mediaType: "text/css"
  },
  reservedPaths: ["/", "/mcp", "/health/live", "/health/ready"]
};

export async function createPlan(
  request: PlanRequest,
  seedbed?: SeedbedControl,
  seedbedDeadlineMs = SEEDBED_PLAN_DEADLINE_MS,
  phaseObserver?: (stage: string) => void
): Promise<AlembicPlan> {
  phaseObserver?.("plan-validation");
  validatePlanRequest(request);
  const normalized = normalizeRequest(request);
  phaseObserver?.("plan-project-attestation");
  const project = await attestProject(request);
  phaseObserver?.("plan-endpoint-policy");
  const endpoint = await approveEndpoint(normalized.endpoint, normalized.mode);
  let seedbedPlan = null;
  if (normalized.mode === "docker-local" && normalized.action !== "remove" && normalized.action !== "adopt") {
    invariant(seedbed !== undefined, "seedbed-required", "Docker-local operations require Seedbed");
    invariant(normalized.docker !== undefined, "docker-request-required", "Docker installation request is required");
    invariant(normalized.docker.endpoint === endpoint.href.replace(/\/$/u, ""), "docker-endpoint-mismatch", "Seedbed endpoint differs from plan");
    const seedbedRequest = toSeedbedRequest(normalized.docker);
    phaseObserver?.("plan-seedbed-control");
    seedbedPlan = await boundedSeedbedCall(
      "plan",
      seedbedDeadlineMs,
      (options) => seedbed.plan(seedbedRequest, options)
    );
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
      canonicalJson(seedbedPlan.request) === canonicalJson(seedbedRequest),
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
    validateWaystoneEvidence(seedbedPlan.waystone);
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
    semanticProfile: normalized.docker?.semantic
      ? semanticProfile(normalized.docker.semantic)
      : null,
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
  phaseObserver?.("plan-store-write");
  await new OperationStore(project.root).writePlan(plan);
  phaseObserver?.("plan-complete");
  return plan;
}

export function validateWaystoneEvidence(
  evidence: WaystoneEvidenceV1 | undefined
): asserts evidence is WaystoneEvidenceV1 {
  invariant(evidence !== undefined, "waystone-default-missing", "Seedbed plan lacks the required default Waystone profile");
  exactAllowedKeys(
    evidence,
    ["enabled", "prefix", "manifestSha256", "entrypoint", "reservedPaths"],
    "Waystone evidence"
  );
  exactAllowedKeys(evidence.entrypoint, ["path", "sha256", "bytes", "mediaType"], "Waystone entrypoint");
  const entrypointSegments = evidence.entrypoint.path.split("/");
  invariant(
      evidence.enabled === true &&
      evidence.prefix === "/app" &&
      /^[0-9a-f]{64}$/u.test(evidence.manifestSha256) &&
      !evidence.entrypoint.path.startsWith("/") &&
      evidence.entrypoint.path.endsWith(".css") &&
      !/%|\\/u.test(evidence.entrypoint.path) &&
      entrypointSegments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
      /^[0-9a-f]{64}$/u.test(evidence.entrypoint.sha256) &&
      Number.isSafeInteger(evidence.entrypoint.bytes) &&
      evidence.entrypoint.bytes > 0 &&
      evidence.entrypoint.bytes <= 16 * 1024 * 1024 &&
      evidence.entrypoint.mediaType === "text/css" &&
      canonicalJson(evidence.reservedPaths) ===
        canonicalJson(["/", "/mcp", "/health/live", "/health/ready"]) &&
      canonicalJson(evidence) === canonicalJson(WAYSTONE_DEFAULT_EVIDENCE),
    "waystone-default-invalid",
    "Seedbed Waystone evidence differs from the required /app asset and reserved-route contract"
  );
}

export function verifyPlan(plan: AlembicPlan): void {
  const { digest, ...unsigned } = plan;
  invariant(plan.format === "gnolith-alembic-plan-v1", "plan-format", "Unsupported plan format");
  invariant(digest === sha256(canonicalJson(unsigned)), "plan-digest", "Plan digest mismatch");
  invariant(new Date(plan.expiresAt).getTime() > Date.now(), "plan-expired", "Plan has expired");
  invariant(plan.compatibility.alembic === ALEMBIC_VERSION, "plan-version", "Plan was made by another Alembic version");
  if (plan.seedbedPlan !== null) {
    validateWaystoneEvidence(plan.seedbedPlan.waystone);
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
    const semantic = plan.seedbedPlan.request.semantic;
    invariant(
      canonicalJson(plan.semanticProfile) === canonicalJson(semantic ? semanticProfile(semantic) : null),
      "semantic-plan-binding-mismatch",
      "Semantic profile differs from the approved Seedbed plan"
    );
  } else {
    invariant(
      plan.seedbedLocalBuildTrust === null,
      "seedbed-local-build-trust-unexpected",
      "Seedbed local-build trust evidence is not applicable"
    );
    invariant(plan.semanticProfile === null, "semantic-profile-unexpected", "Semantic profile is not applicable");
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
  invariant(
    request.expected.operationVersion === String(WORKSHOP_OPERATION_SCHEMA_VERSION),
    "expected-operation-schema",
    "Expected Workshop operation schema is incompatible"
  );
  if (request.docker) {
    exactAllowedKeys(
      request.docker,
      ["installationId", "baseIri", "endpoint", "image", "semantic", "expected"],
      "Docker request"
    );
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
      request.docker.installationId === request.expected.installationId &&
        canonicalBaseIri(request.docker.baseIri) === canonicalBaseIri(request.expected.baseIri),
      "docker-identity-mismatch",
      "Docker and Alembic expected canonical identities differ"
    );
    invariant(
      canonicalJson({
        ...request.docker.expected,
        baseIri: canonicalBaseIri(request.docker.expected.baseIri)
      }) === canonicalJson({
        ...request.expected,
        baseIri: canonicalBaseIri(request.expected.baseIri)
      }),
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
    if (request.docker.semantic !== undefined) validateSemanticConfiguration(request.docker.semantic);
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
    invariant(validAbsoluteIri(request.legacyEvidence.baseIri),
      "legacy-base-iri", "Legacy evidence base IRI is invalid");
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
    invariant(validAbsoluteIri(request.legacyAdoption.baseIri),
      "legacy-base-iri", "Legacy adoption base IRI is invalid");
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
    canonicalBaseIri(value);
    return true;
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
    baseIri: canonicalBaseIri(request.expected.baseIri),
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
      baseIri: canonicalBaseIri(request.docker.baseIri),
      endpoint: request.docker.endpoint,
      image: { ...request.docker.image },
      ...(request.docker.semantic !== undefined
        ? { semantic: normalizeSemanticConfiguration(request.docker.semantic) }
        : {}),
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
      baseIri: canonicalBaseIri(request.legacyAdoption.baseIri),
      domainCount: request.legacyAdoption.domainCount,
      payloadDigest: request.legacyAdoption.payloadDigest,
      catalogDigest: request.legacyAdoption.catalogDigest,
      ownerLedgerDigest: request.legacyAdoption.ownerLedgerDigest,
      protectedTokenFile: { ...request.legacyAdoption.protectedTokenFile }
    };
  }
  if (request.legacyEvidence !== undefined) {
    normalized.legacyEvidence = {
      ...request.legacyEvidence,
      baseIri: canonicalBaseIri(request.legacyEvidence.baseIri)
    };
  }
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

function toSeedbedRequest(request: NonNullable<PlanRequest["docker"]>): NonNullable<PlanRequest["docker"]> {
  return {
    ...request,
    image: { ...request.image },
    ...(request.semantic === undefined ? {} : { semantic: request.semantic }),
    expected: {
      ...request.expected,
      operationVersion: String(WORKSHOP_MIGRATION_SCHEMA_VERSION)
    }
  };
}

export function semanticFingerprint(configuration: SemanticConfigurationV1): string {
  const normalized = normalizeSemanticCore(configuration);
  return sha256(canonicalJson({
    version: 1,
    provider: normalized.provider,
    vector: normalized.vector
  }));
}

function validateSemanticConfiguration(semantic: SeedbedSemanticConfigurationV1): void {
  exactAllowedKeys(
    semantic,
    ["configuration", "expectedRevision", "credentialSelectors"],
    "Seedbed semantic configuration"
  );
  invariant(
    Number.isSafeInteger(semantic.expectedRevision) &&
      semantic.expectedRevision >= 0 &&
      semantic.expectedRevision < Number.MAX_SAFE_INTEGER,
    "semantic-revision",
    "Semantic expected revision is invalid"
  );
  const configuration = normalizeSemanticCore(semantic.configuration);
  invariant(
    semantic.credentialSelectors.length <= 16,
    "semantic-selector-bound",
    "Semantic credential selector count exceeds the bound"
  );
  const selectorIds = new Set<string>();
  for (const selector of semantic.credentialSelectors) {
    exactAllowedKeys(selector, ["id", "kind", "path"], "semantic credential selector");
    invariant(
      validIdentifier(selector.id) &&
        !selectorIds.has(selector.id) &&
        selector.kind === "protected-file-v1" &&
        isAbsolute(selector.path) &&
        normalize(selector.path) === resolve(selector.path) &&
        selector.path === selector.path.normalize("NFC"),
      "semantic-selector-invalid",
      "Semantic credential selector is invalid"
    );
    selectorIds.add(selector.id);
  }
  const referenced = new Set<string>();
  if (configuration.provider.credentialSelector !== null) {
    referenced.add(configuration.provider.credentialSelector);
  }
  if (configuration.vector.kind === "qdrant" &&
      configuration.vector.credentialSelector !== null) {
    referenced.add(configuration.vector.credentialSelector);
  }
  invariant(
    [...referenced].every((id) => selectorIds.has(id)),
    "semantic-selector-missing",
    "Semantic configuration references an absent credential selector"
  );
  invariant(
    referenced.size === selectorIds.size && [...selectorIds].every((id) => referenced.has(id)),
    "semantic-selector-unused",
    "Semantic configuration contains an unreferenced credential selector"
  );
}

function normalizeSemanticConfiguration(
  semantic: SeedbedSemanticConfigurationV1
): SeedbedSemanticConfigurationV1 {
  validateSemanticConfiguration(semantic);
  return {
    configuration: normalizeSemanticCore(semantic.configuration),
    expectedRevision: semantic.expectedRevision,
    credentialSelectors: [...semantic.credentialSelectors]
      .map((selector) => ({ ...selector }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
}

function normalizeSemanticCore(configuration: SemanticConfigurationV1): SemanticConfigurationV1 {
  exactAllowedKeys(configuration, ["version", "id", "name", "provider", "vector"], "semantic configuration");
  invariant(
    configuration.version === 1 &&
      validIdentifier(configuration.id) &&
      validIdentifier(configuration.name),
    "semantic-version",
    "Semantic configuration identity or version is invalid"
  );
  exactAllowedKeys(
    configuration.provider,
    [
      "kind", "endpoint", "model", "dimensions", "metric", "credentialSelector",
      "allowPrivateEndpoint", "redirectPolicy"
    ],
    "semantic provider"
  );
  invariant(
    ["openai-compatible", "ollama-compatible"].includes(configuration.provider.kind) &&
      validIdentifier(configuration.provider.model) &&
      Number.isSafeInteger(configuration.provider.dimensions) &&
      configuration.provider.dimensions > 0 &&
      configuration.provider.dimensions <= 65536 &&
      ["cosine", "dot", "euclid"].includes(configuration.provider.metric) &&
      (configuration.provider.credentialSelector === null ||
        validIdentifier(configuration.provider.credentialSelector)) &&
      configuration.provider.redirectPolicy === "error",
    "semantic-provider",
    "Semantic provider configuration is invalid"
  );
  const providerEndpoint = normalizeSemanticEndpoint(configuration.provider.endpoint);
  validateSemanticEndpoint(
    providerEndpoint,
    configuration.provider.allowPrivateEndpoint,
    configuration.provider.kind === "ollama-compatible" ? "ollama" : null
  );

  let vector: SemanticConfigurationV1["vector"];
  if (configuration.vector.kind === "sqlite") {
    exactAllowedKeys(configuration.vector, ["kind"], "SQLite semantic vector");
    vector = { kind: "sqlite" };
  } else {
    exactAllowedKeys(
      configuration.vector,
      [
        "kind", "endpoint", "collection", "credentialSelector",
        "allowPrivateEndpoint", "redirectPolicy"
      ],
      "Qdrant semantic vector"
    );
    invariant(
      configuration.vector.kind === "qdrant" &&
        validIdentifier(configuration.vector.collection) &&
        (configuration.vector.credentialSelector === null ||
          validIdentifier(configuration.vector.credentialSelector)) &&
        configuration.vector.redirectPolicy === "error",
      "semantic-vector",
      "Semantic vector configuration is invalid"
    );
    const vectorEndpoint = normalizeSemanticEndpoint(configuration.vector.endpoint);
    validateSemanticEndpoint(vectorEndpoint, configuration.vector.allowPrivateEndpoint, "qdrant");
    vector = { ...configuration.vector, endpoint: vectorEndpoint };
  }
  return {
    version: 1,
    id: configuration.id,
    name: configuration.name,
    provider: { ...configuration.provider, endpoint: providerEndpoint },
    vector
  };
}

function semanticProfile(semantic: SeedbedSemanticConfigurationV1): SemanticPlanProfileV1 {
  const normalized = normalizeSemanticConfiguration(semantic);
  const configuration = normalized.configuration;
  return {
    format: "gnolith-alembic-semantic-profile-v1",
    revision: normalized.expectedRevision + 1,
    fingerprint: semanticFingerprint(configuration),
    configurationId: configuration.id,
    providerKind: configuration.provider.kind,
    vectorKind: configuration.vector.kind,
    providerEndpoint: configuration.provider.endpoint,
    vectorEndpoint: configuration.vector.kind === "qdrant" ? configuration.vector.endpoint : null,
    credentialSelectorIds: normalized.credentialSelectors.map(({ id }) => id)
  };
}

function normalizeSemanticEndpoint(value: string): string {
  try {
    const endpoint = new URL(value);
    const hostname = endpoint.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
      endpoint.hostname = "host.docker.internal";
    }
    return endpoint.href.replace(/\/$/u, "");
  } catch {
    invariant(false, "semantic-endpoint", "Semantic endpoint is invalid");
  }
}

function validateSemanticEndpoint(
  value: string,
  allowPrivateEndpoint: boolean,
  composeService: "ollama" | "qdrant" | null
): void {
  const exactCompose = composeService === "ollama"
    ? isExactComposeEndpoint(value, "ollama", "11434")
    : composeService === "qdrant" && isExactComposeEndpoint(value, "qdrant", "6333");
  const exactDockerHost = isExactDockerHostEndpoint(value);
  if (allowPrivateEndpoint || exactCompose || exactDockerHost) {
    invariant(
      allowPrivateEndpoint === true && (exactCompose || exactDockerHost),
      "semantic-private-endpoint-denied",
      "Semantic private endpoint is not an explicitly approved Docker host-gateway or Compose-local target"
    );
    return;
  }
  const endpoint = new URL(value);
  invariant(
    endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.search === "" &&
      endpoint.hash === "" &&
      isPublicSemanticHostname(endpoint.hostname),
    "semantic-public-endpoint-denied",
    "Semantic public endpoint must be credential-free HTTPS with a public hostname"
  );
}

function isExactDockerHostEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    const hostname = endpoint.hostname.toLowerCase();
    return ["http:", "https:"].includes(endpoint.protocol) &&
      hostname === "host.docker.internal" &&
      endpoint.port !== "" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.search === "" &&
      endpoint.hash === "";
  } catch {
    return false;
  }
}

function isPublicSemanticHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (
    host === "localhost" ||
    [".localhost", ".local", ".internal", ".home", ".lan"].some((suffix) => host.endsWith(suffix)) ||
    !host.includes(".")
  ) {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) {
    const octets = host.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return octets.every((part) => part >= 0 && part <= 255) &&
      first !== 10 &&
      first !== 127 &&
      !(first === 100 && second >= 64 && second <= 127) &&
      !(first === 169 && second === 254) &&
      !(first === 172 && second >= 16 && second <= 31) &&
      !(first === 192 && second === 0) &&
      !(first === 192 && second === 168) &&
      !(first === 198 && (second === 18 || second === 19)) &&
      first < 224 &&
      first !== 0;
  }
  return !host.includes(":");
}

function isExactComposeEndpoint(
  value: string,
  expectedHostname: "ollama" | "qdrant",
  expectedPort: "11434" | "6333"
): boolean {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "http:" &&
      endpoint.hostname === expectedHostname &&
      endpoint.port === expectedPort &&
      (endpoint.pathname === "/" || endpoint.pathname === "") &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.search === "" &&
      endpoint.hash === "";
  } catch {
    return false;
  }
}
