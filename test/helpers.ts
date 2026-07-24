import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, sha256 } from "../src/canonical.js";
import { semanticFingerprint } from "../src/plans.js";
import { WORKSHOP_CATALOG_DIGEST, WORKSHOP_TOOL_NAMES } from "../src/workshop.js";
import type {
  DockerInstallationRequest,
  ExpectedWorkshopStatus,
  InstallationPlan,
  InstallationReceipt,
  SeedbedControl,
  WorkshopStatusOutput
} from "../src/types.js";
import type { WorkshopTransport } from "../src/workshop.js";

export async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "alembic-test-"));
  await mkdir(join(path, ".codex"), { recursive: true });
  return realpath(path);
}

export const expectedStatus: ExpectedWorkshopStatus = {
  installationId: "installation-test",
  baseIri: "https://example.test/base/",
  serverVersion: "0.5.0",
  operationVersion: "11",
  catalogDigest: WORKSHOP_CATALOG_DIGEST,
  migrationReady: true,
  canonicalReady: true,
  authorizationReady: true,
  lexicalReady: true,
  blobReady: true,
  producerStatus: "ready",
  semanticState: "ready",
  allowLexicalOnly: false
};

export const localBuildSelection = {
  kind: "seedbed-local-build-v1" as const,
  selector: "gnolith-seedbed-local-build-v1" as const,
  pullPolicy: "never" as const,
  componentLockSha256: "d41872d741f1a6f0f5e10a5572e48b2a47851c143a515327b90acebddd258644",
  graphSha256: "abf40b3390a7f3659810a74417708a0775cc190f22654cb253df488932b79896",
  composeBundleSha256: "e856f03d669e80615f91b609eaee4d0ca37e3b86e424f803e47a4008e9727a36"
};

export const workshopStatus: WorkshopStatusOutput = {
  installationId: expectedStatus.installationId,
  baseIri: expectedStatus.baseIri,
  principalId: "codex-assistant",
  credentialId: "credential-test",
  activeWorkspaceId: "primary",
  capabilities: ["gnolith:use"],
  authorizationRevision: 1,
  migrationReadiness: { namespace: "@gnolith/workshop", version: 11, ready: true },
  compatibility: { diamond: true, taproot: true },
  canonicalReady: true,
  authorizationReady: true,
  lexicalReady: true,
  semanticState: {
    state: "ready",
    configured: true,
    revision: 1,
    fingerprint: "a".repeat(64),
    ready: true
  },
  producers: { ready: true, fingerprint: "producer-fingerprint", kinds: ["task", "memory", "prompt"] },
  blobReady: true,
  versions: { server: "0.5.0", operationSchema: 2 },
  operationCatalogDigest: WORKSHOP_CATALOG_DIGEST
};

export class MockWorkshop implements WorkshopTransport {
  constructor(
    private readonly status = workshopStatus,
    private readonly identity = "gnolith",
    private readonly tools: readonly string[] = WORKSHOP_TOOL_NAMES
  ) {}
  async call(_endpoint: URL, _token: string, method: string, _params?: unknown, _sessionId?: string) {
    if (method === "initialize") {
      return {
        response: {
          jsonrpc: "2.0" as const,
          id: 1,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: this.identity } }
        },
        sessionId: "session-test"
      };
    }
    if (method === "tools/list") {
      return { response: { jsonrpc: "2.0" as const, id: 1, result: { tools: this.tools.map((name) => ({ name })) } } };
    }
    return {
      response: {
        jsonrpc: "2.0" as const,
        id: 1,
        result: { structuredContent: this.status }
      }
    };
  }
}

export class MockSeedbed implements SeedbedControl {
  public applied = 0;
  public resumed = 0;
  constructor(private readonly tokenPath: string, private readonly tokenDigest: string) {}
  async inspect() {
    return { found: true, installationId: expectedStatus.installationId, state: "ready" };
  }
  async plan(request: DockerInstallationRequest): Promise<InstallationPlan> {
    return {
      id: "seedbed-plan",
      digest: sha256(canonicalJson(request)),
      version: "gnolith-seedbed-control-plan-v2",
      request,
      steps: ["fixed Seedbed assembly"],
      stateRoot: {
        kind: "external-directory",
        canonicalPath: join(this.tokenPath, "..", "seedbed-state")
      }
    };
  }
  async apply(plan: InstallationPlan): Promise<InstallationReceipt> {
    this.applied += 1;
    return this.receipt(plan);
  }
  async resume() {
    this.resumed += 1;
    const request: DockerInstallationRequest = {
      installationId: expectedStatus.installationId,
      baseIri: expectedStatus.baseIri,
      endpoint: "http://127.0.0.1/mcp",
      image: localBuildSelection,
      expected: expectedStatus
    };
    return this.receipt(await this.plan(request));
  }
  async diagnose() {
    return {
      installationId: expectedStatus.installationId,
      classification: "local-workshop-unavailable",
      repair: {
        kind: "seedbed-resume-operation-v1" as const,
        operationId: "seedbed-plan",
        action: "restart-recorded-compose" as const
      }
    };
  }
  private receipt(plan: InstallationPlan): InstallationReceipt {
    return {
      operationId: plan.id,
      state: "ready",
      version: "0.4.0",
      digest: plan.digest,
      endpoint: plan.request.endpoint,
      installationId: plan.request.installationId,
      baseIri: plan.request.baseIri,
      expected: plan.request.expected,
      ...(plan.request.semantic
        ? {
            semantic: {
              fingerprint: semanticFingerprint(plan.request.semantic.configuration),
              revision: plan.request.semantic.expectedRevision + 1,
              state:
                plan.request.expected.semanticState === "absent"
                  ? "unconfigured" as const
                  : plan.request.expected.semanticState
            }
          }
        : {}),
      protectedTokenFile: {
        kind: "protected-file",
        canonicalPath: this.tokenPath,
        credentialId: "credential-test",
        sha256: this.tokenDigest
      },
      environmentSelector: "GNOLITH_BEARER_TOKEN"
    };
  }
}

export async function protectedToken(root: string, token = "canonical_token_123"): Promise<{ path: string; digest: string; token: string }> {
  const path = join(root, "protected-token");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return { path, digest: sha256(token), token };
}
