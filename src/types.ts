export const ALEMBIC_VERSION = "0.1.0";
export const WORKSHOP_IDENTITY = "gnolith";
export const WORKSHOP_PATH = "/mcp";
export const BEGIN_MARKER = "# BEGIN ALEMBIC MANAGED GNOLITH MCP";
export const END_MARKER = "# END ALEMBIC MANAGED GNOLITH MCP";
export const LOCAL_BEARER_ENV = "GNOLITH_BEARER_TOKEN";
export const TOOL_NAMES = [
  "alembic_inspect",
  "alembic_discover",
  "alembic_plan",
  "alembic_apply",
  "alembic_operation_read",
  "alembic_operation_resume",
  "alembic_diagnose",
  "alembic_legacy_inspect",
  "alembic_legacy_adopt"
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
export type Mode = "docker-local" | "remote";
export type Action = "create" | "connect" | "repair" | "rebind" | "remove" | "adopt";
export type OperationState =
  | "planned"
  | "applying"
  | "activation-prerequisite"
  | "activation-required"
  | "failed";

export interface ProtectedFileSelector {
  kind: "protected-file";
  canonicalPath: string;
  credentialId: string;
  sha256: string;
}
export interface InheritedDescriptorSelector {
  kind: "inherited-descriptor";
  descriptorId: string;
}
export interface EnvironmentSelector {
  kind: "environment";
  variable: typeof LOCAL_BEARER_ENV;
}
export interface HostOAuthSelector {
  kind: "host-oauth";
  profile: "remote-oauth-v1";
  issuer: string;
  audience: string;
  scopes: readonly string[];
}
export type AuthenticationSelector =
  | EnvironmentSelector
  | HostOAuthSelector
  | ProtectedFileSelector
  | InheritedDescriptorSelector;

export interface ExpectedWorkshopStatus {
  installationId: string;
  baseIri: string;
  serverVersion: string;
  operationVersion: string;
  catalogDigest: string;
  migrationReady: boolean;
  canonicalReady: boolean;
  authorizationReady: boolean;
  lexicalReady: boolean;
  blobReady: boolean;
  producerStatus: "ready" | "degraded" | "absent";
  semanticState: "ready" | "degraded" | "absent";
  allowLexicalOnly: boolean;
}

export interface WorkshopStatusOutput {
  installationId: string;
  baseIri: string;
  principalId: string;
  credentialId: string;
  activeWorkspaceId: string | null;
  capabilities: readonly string[];
  authorizationRevision: number;
  migrationReadiness: { namespace: "@gnolith/workshop"; version: number; ready: boolean };
  compatibility: { diamond: boolean; taproot: boolean };
  canonicalReady: boolean;
  authorizationReady: boolean;
  lexicalReady: boolean;
  semanticState: { state: "ready" | "degraded" | "unconfigured"; configured: boolean };
  producers: { ready: boolean; fingerprint: string; kinds: readonly ("task" | "memory" | "prompt")[] };
  blobReady: boolean;
  versions: { server: string; operationSchema: 9 };
  operationCatalogDigest: string;
}

export interface HostMetadataV1 {
  version: 1;
  taskDirectory: string;
  projectRoot: string;
  trusted: boolean;
  managedPolicy: "allow" | "deny";
}

export interface ProjectAttestation {
  root: string;
  configPath: string;
  configDigest: string | null;
  metadataVersion: 1 | null;
  trusted: boolean;
  confirmedFallback: boolean;
  identity: string;
}

export interface DockerInstallationRequest {
  installationId: string;
  baseIri: string;
  endpoint: string;
  image: DockerImageSelection;
  expected: ExpectedWorkshopStatus;
}
export interface SeedbedLocalBuildSelection {
  kind: "seedbed-local-build-v1";
  selector: "gnolith-seedbed-local-build-v1";
  pullPolicy: "never";
  componentLockSha256: string;
  graphSha256: string;
  composeBundleSha256: string;
}
export interface DigestQualifiedPulledImageSelection {
  kind: "digest-qualified-pulled-image-v1";
  reference: string;
  pullPolicy: "digest-only";
}
export type DockerImageSelection =
  | SeedbedLocalBuildSelection
  | DigestQualifiedPulledImageSelection;
export interface SeedbedLocalBuildTrust {
  format: "gnolith-alembic-seedbed-local-build-trust-v1";
  seedbedCandidateSha256: string;
  localBuild: SeedbedLocalBuildSelection;
}
export interface InstallationSelector {
  installationId: string;
  projectRoot: string;
}
export interface InstallationInspection {
  found: boolean;
  installationId: string | null;
  state: string;
}
export interface InstallationPlan {
  id: string;
  digest: string;
  version: string;
  request: DockerInstallationRequest;
  steps: readonly string[];
  stateRoot: {
    kind: "external-directory";
    canonicalPath: string;
  };
}
export interface InstallationReceipt {
  operationId: string;
  state: "applying" | "failed" | "ready";
  version: string;
  digest: string;
  endpoint: string;
  installationId: string;
  baseIri: string;
  expected: ExpectedWorkshopStatus;
  protectedTokenFile: ProtectedFileSelector;
  environmentSelector: typeof LOCAL_BEARER_ENV;
}
export interface InstallationDiagnosis {
  installationId: string;
  classification: string;
  restartAllowed: boolean;
}
export interface SeedbedControl {
  inspect(request: InstallationSelector): Promise<InstallationInspection>;
  plan(request: DockerInstallationRequest): Promise<InstallationPlan>;
  apply(plan: InstallationPlan): Promise<InstallationReceipt>;
  resume(operationId: string): Promise<InstallationReceipt>;
  diagnose(request: InstallationSelector): Promise<InstallationDiagnosis>;
}

export interface PlanRequest {
  taskDirectory: string;
  confirmedProjectRoot?: string;
  hostMetadata?: HostMetadataV1;
  action: Action;
  mode: Mode;
  endpoint: string;
  authentication: EnvironmentSelector | HostOAuthSelector;
  expected: ExpectedWorkshopStatus;
  docker?: DockerInstallationRequest;
  seedbedStateRoot?: string;
  acceptLexicalOnly?: boolean;
  legacyAdoption?: LegacyLocalAdoptionReceipt;
  legacyEvidence?: {
    installationId: string;
    baseIri: string;
    domainCount: number;
    payloadDigest: string;
    catalogDigest: string;
    ownerLedgerDigest: string;
  };
  legacyHandoff?: {
    bundleDigest: string;
    operationIds: readonly string[];
  };
}

export interface AlembicPlan {
  format: "gnolith-alembic-plan-v1";
  planId: string;
  operationId: string;
  createdAt: string;
  expiresAt: string;
  requestDigest: string;
  project: ProjectAttestation;
  action: Action;
  mode: Mode;
  endpoint: string;
  authentication: EnvironmentSelector | HostOAuthSelector;
  expected: ExpectedWorkshopStatus;
  seedbedPlan: InstallationPlan | null;
  seedbedPlanDigest: string | null;
  seedbedLocalBuildTrust: SeedbedLocalBuildTrust | null;
  seedbedStateRoot: string | null;
  legacyAdoption: LegacyLocalAdoptionReceipt | null;
  legacyHandoff: {
    bundleDigest: string;
    operationIds: readonly string[];
  } | null;
  compatibility: {
    alembic: string;
    seedbed: string;
    workshop: string;
    legacy: string;
  };
  approvedSteps: readonly string[];
  digest: string;
}

export interface Checkpoint {
  step: string;
  phase: "before" | "after";
  at: string;
}
export interface AlembicReceipt {
  format: "gnolith-alembic-operation-v1";
  operationId: string;
  planId: string;
  planDigest: string;
  state: OperationState;
  startedAt: string;
  updatedAt: string;
  checkpoints: readonly Checkpoint[];
  projectRoot: string;
  configBeforeDigest: string | null;
  configAfterDigest: string | null;
  endpoint: string;
  authentication: "local-bearer-v1" | "remote-oauth-v1";
  seedbed: {
    version: string;
    digest: string;
    operationId: string;
  } | null;
  verificationDigest: string | null;
  previousReceipt: string | null;
  message: string;
}

export interface WorkshopVerification {
  identity: typeof WORKSHOP_IDENTITY;
  protocolVersion: string;
  tools: readonly string[];
  status: WorkshopStatusOutput;
  digest: string;
}

export interface OAuthMetadata {
  resource: string;
  authorizationServers: readonly string[];
  issuer: string;
  audience: string;
  scopes: readonly string[];
  algorithms: readonly string[];
}

export interface OAuthHost {
  discover(endpoint: URL): Promise<OAuthMetadata>;
  authorize(selector: HostOAuthSelector, metadata: OAuthMetadata): Promise<{ descriptorId: string }>;
  accessToken(descriptorId: string): Promise<string>;
}

export interface LegacyReceipt {
  format: "gnolith-setup-operation-v1";
  operationId: string;
  planId: string;
  state: "applying" | "failed" | "activation-required" | "complete";
  method: "process" | "docker" | "remote-http" | "codex-sites";
  action: "create" | "connect";
  startedAt: string;
  updatedAt: string;
  completedSteps: readonly string[];
  expectedInstallationId: string | null;
  expectedBaseIri: string | null;
}
export interface LegacyHandoffBundle {
  format: "gnolith-setup-to-alembic-v1";
  schemaVersion: 1;
  projectRoot: string;
  configDigest: string | null;
  legacyMarkerDigest: string | null;
  marker: {
    begin: typeof BEGIN_MARKER;
    end: typeof END_MARKER;
    state: "absent" | "complete" | "invalid" | "user-owned";
  };
  connection: {
    mode: "process" | "docker" | "remote-http" | "codex-sites" | "unknown";
    endpoint: string | null;
    authentication:
      | { kind: "none" }
      | { kind: "bearer-environment"; variable: string }
      | { kind: "oauth" }
      | { kind: "chatgpt" };
  } | null;
  receipts: readonly LegacyReceipt[];
  sha256: string;
}

export interface LegacyLocalAdoptionReceipt {
  format: "gnolith-seedbed-legacy-adoption-v1";
  version: "0.1.0";
  operationId: string;
  state: "ready";
  installationId: string;
  baseIri: string;
  domainCount: number;
  payloadDigest: string;
  catalogDigest: string;
  ownerLedgerDigest: string;
  protectedTokenFile: ProtectedFileSelector;
}

export interface AlembicLegacyAdoptionReceipt {
  format: "gnolith-alembic-legacy-adoption-v1";
  originalBundleDigest: string;
  legacyPackage: "@gnolith/codex-plugin@0.2.0";
  legacyOperationIds: readonly string[];
  alembicPlanId: string;
  seedbedAdoptionDigest: string | null;
  configBeforeDigest: string | null;
  configAfterDigest: string;
  reversible: true;
  createdAt: string;
}
