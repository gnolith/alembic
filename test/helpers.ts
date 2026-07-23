import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, sha256 } from "../src/canonical.js";
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
  serverVersion: "0.1.0",
  operationVersion: "1",
  catalogDigest: "a".repeat(64),
  migrationReady: true,
  canonicalReady: true,
  authorizationReady: true,
  lexicalReady: true,
  blobReady: true,
  producerStatus: "ready",
  semanticState: "ready",
  allowLexicalOnly: false
};

export const workshopStatus: WorkshopStatusOutput = {
  installationId: expectedStatus.installationId,
  baseIri: expectedStatus.baseIri,
  principalId: "codex-assistant",
  credentialId: "credential-test",
  activeWorkspaceId: "primary",
  workspaceIds: ["primary"],
  capabilities: ["gnolith:use"],
  authorizationRevision: 1,
  migrationReadiness: { namespace: "@gnolith/workshop", version: 1, ready: true },
  compatibility: { diamond: true, taproot: true },
  canonicalReady: true,
  authorizationReady: true,
  lexicalReady: true,
  semanticState: { state: "ready", configured: true },
  producers: { ready: true, fingerprint: "producer-fingerprint", kinds: ["task", "memory", "prompt"] },
  blobReady: true,
  versions: { server: "0.1.0", operationSchema: 1 },
  operationCatalogDigest: "a".repeat(64)
};

export class MockWorkshop implements WorkshopTransport {
  constructor(
    private readonly status = workshopStatus,
    private readonly identity = "gnolith",
    private readonly tools = ["gnolith_status", "gnolith_read"]
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
      version: "0.1.0",
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
      image: "ghcr.io/gnolith/workshop@sha256:" + "b".repeat(64),
      expected: expectedStatus
    };
    return this.receipt(await this.plan(request));
  }
  async diagnose() {
    return { installationId: expectedStatus.installationId, classification: "ready", restartAllowed: true };
  }
  private receipt(plan: InstallationPlan): InstallationReceipt {
    return {
      operationId: "seedbed-operation",
      state: "ready",
      version: "0.1.0",
      digest: "c".repeat(64),
      endpoint: plan.request.endpoint,
      installationId: plan.request.installationId,
      baseIri: plan.request.baseIri,
      expected: plan.request.expected,
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
