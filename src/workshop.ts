import { readFile, lstat, realpath } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isAbsolute, normalize, resolve } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import { approveEndpoint, assertDnsStable } from "./endpoint.js";
import { invariant } from "./errors.js";
import {
  LOCAL_BEARER_ENV,
  WORKSHOP_IDENTITY,
  type EnvironmentSelector,
  type ExpectedWorkshopStatus,
  type HostOAuthSelector,
  type Mode,
  type OAuthHost,
  type ProtectedFileSelector,
  type WorkshopStatusOutput,
  type WorkshopVerification
} from "./types.js";

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface WorkshopTransport {
  call(endpoint: URL, token: string, method: string, params: unknown, sessionId?: string): Promise<{
    response: RpcResponse;
    sessionId?: string;
  }>;
}

export class FetchWorkshopTransport implements WorkshopTransport {
  constructor(
    private readonly timeoutMs = 15_000,
    private readonly maxResponseBytes = 1_048_576
  ) {}

  async call(endpoint: URL, token: string, method: string, params: unknown, sessionId?: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2025-06-18"
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal
      });
      invariant(response.ok, "workshop-http", `Workshop returned HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length") ?? "0");
      invariant(length <= this.maxResponseBytes, "response-too-large", "Workshop response exceeds configured bound");
      const body = await response.text();
      invariant(Buffer.byteLength(body) <= this.maxResponseBytes, "response-too-large", "Workshop response exceeds configured bound");
      const parsed = parseMcpBody(body) as RpcResponse;
      invariant(parsed.jsonrpc === "2.0" && parsed.error === undefined, "workshop-rpc", "Workshop MCP call failed");
      const returnedSession = response.headers.get("mcp-session-id") ?? undefined;
      return returnedSession
        ? { response: parsed, sessionId: returnedSession }
        : { response: parsed };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseMcpBody(body: string): unknown {
  if (body.startsWith("event:") || body.startsWith("data:")) {
    const data = body
      .split(/\r?\n/gu)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    return JSON.parse(data);
  }
  return JSON.parse(body);
}

async function localToken(selector: ProtectedFileSelector): Promise<string> {
  invariant(
    isAbsolute(selector.canonicalPath) &&
      normalize(selector.canonicalPath) === resolve(selector.canonicalPath) &&
      selector.canonicalPath === selector.canonicalPath.normalize("NFC"),
    "unsafe-token-file",
    "Protected credential selector path is not canonical"
  );
  invariant(
    await realpath(selector.canonicalPath) === selector.canonicalPath,
    "unsafe-token-file",
    "Protected credential selector resolves through an alias"
  );
  const info = await lstat(selector.canonicalPath);
  invariant(info.isFile() && !info.isSymbolicLink(), "unsafe-token-file", "Protected credential selector is not a regular file");
  if (process.platform !== "win32") {
    invariant((info.mode & 0o077) === 0, "token-file-permissions", "Protected credential file is accessible by other users");
  }
  const bytes = await readFile(selector.canonicalPath);
  invariant(bytes.byteLength <= 4096, "token-file-too-large", "Protected credential file exceeds 4 KiB");
  let token = bytes.toString("utf8");
  if (token.endsWith("\n")) token = token.slice(0, -1);
  invariant(!token.includes("\r") && !token.includes("\n"), "invalid-token-file", "Protected token must be one base64url line");
  invariant(/^[A-Za-z0-9_-]+$/u.test(token), "invalid-token-file", "Protected token is not canonical base64url text");
  invariant(sha256(token) === selector.sha256, "token-digest-mismatch", "Protected credential digest mismatch");
  invariant(
    process.env[LOCAL_BEARER_ENV] === token,
    "activation-prerequisite",
    "Inject the protected credential into the Codex parent process using an OS/user secret facility, then retry"
  );
  return token;
}

function compareStatus(observed: WorkshopStatusOutput, expected: ExpectedWorkshopStatus): void {
  const exact = [
    "installationId", "baseIri", "principalId", "credentialId", "activeWorkspaceId",
    "capabilities", "authorizationRevision", "migrationReadiness",
    "compatibility", "canonicalReady", "authorizationReady", "lexicalReady",
    "semanticState", "producers", "blobReady", "versions", "operationCatalogDigest"
  ];
  invariant(
    canonicalJson(Object.keys(observed).sort()) === canonicalJson([...exact].sort()),
    "invalid-status-shape",
    "gnolith_status violates the pinned Workshop output schema"
  );
  invariant(
    exactKeys(observed.migrationReadiness, ["namespace", "version", "ready"]) &&
      exactKeys(observed.compatibility, ["diamond", "taproot"]) &&
      exactKeys(observed.semanticState, ["state", "configured"]) &&
      exactKeys(observed.producers, ["ready", "fingerprint", "kinds"]) &&
      exactKeys(observed.versions, ["server", "operationSchema"]) &&
      [observed.installationId, observed.baseIri, observed.principalId, observed.credentialId,
        observed.producers.fingerprint, observed.versions.server].every((value) => typeof value === "string" && value.length > 0) &&
      (observed.activeWorkspaceId === null || (typeof observed.activeWorkspaceId === "string" && observed.activeWorkspaceId.length > 0)) &&
      ["ready", "degraded", "unconfigured"].includes(observed.semanticState.state) &&
      observed.semanticState.configured === (observed.semanticState.state !== "unconfigured") &&
    observed.migrationReadiness.namespace === "@gnolith/workshop" &&
      Number.isInteger(observed.migrationReadiness.version) &&
      observed.migrationReadiness.version > 0 &&
      observed.versions.operationSchema === 9 &&
      Number.isInteger(observed.authorizationRevision) &&
      observed.authorizationRevision >= 0 &&
      observed.compatibility.diamond &&
      observed.compatibility.taproot &&
      uniqueStrings(observed.capabilities) &&
      uniqueStrings(observed.producers.kinds) &&
      canonicalJson([...observed.producers.kinds].sort()) === canonicalJson(["memory", "prompt", "task"]) &&
      /^[0-9a-f]{64}$/u.test(observed.operationCatalogDigest),
    "invalid-status-shape",
    "gnolith_status nested evidence violates the pinned Workshop schema"
  );
  const comparisons: Readonly<Record<string, [unknown, unknown]>> = {
    installationId: [observed.installationId, expected.installationId],
    baseIri: [observed.baseIri, expected.baseIri],
    serverVersion: [observed.versions.server, expected.serverVersion],
    operationVersion: [String(observed.versions.operationSchema), expected.operationVersion],
    catalogDigest: [observed.operationCatalogDigest, expected.catalogDigest],
    migrationReady: [observed.migrationReadiness.ready, expected.migrationReady],
    canonicalReady: [observed.canonicalReady, expected.canonicalReady],
    authorizationReady: [observed.authorizationReady, expected.authorizationReady],
    lexicalReady: [observed.lexicalReady, expected.lexicalReady],
    blobReady: [observed.blobReady, expected.blobReady],
    producerStatus: [observed.producers.ready ? "ready" : "degraded", expected.producerStatus],
    semanticState: [
      observed.semanticState.state === "unconfigured" ? "absent" : observed.semanticState.state,
      expected.semanticState
    ]
  };
  for (const [key, [actual, wanted]] of Object.entries(comparisons)) {
    invariant(actual === wanted, "workshop-status-mismatch", `Workshop status mismatch: ${key}`);
  }
  invariant(observed.migrationReadiness.ready && observed.canonicalReady && observed.authorizationReady && observed.lexicalReady && observed.blobReady,
    "workshop-not-ready", "Workshop mandatory readiness checks failed");
  invariant(observed.producers.ready, "producer-not-ready", "Workshop producers are not ready");
  invariant(
    observed.semanticState.state === "ready" || expected.allowLexicalOnly,
    "semantic-not-ready",
    "Semantic degradation was not explicitly accepted"
  );
}

function uniqueStrings(values: readonly string[]): boolean {
  return Array.isArray(values) && values.every((value) => typeof value === "string") && new Set(values).size === values.length;
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

export async function verifyWorkshop(input: {
  endpoint: string;
  mode: Mode;
  authentication: EnvironmentSelector | HostOAuthSelector;
  expected: ExpectedWorkshopStatus;
  protectedFile?: ProtectedFileSelector;
  oauthHost?: OAuthHost;
  transport?: WorkshopTransport;
}): Promise<WorkshopVerification> {
  const endpoint = await approveEndpoint(input.endpoint, input.mode);
  const originalAddresses = (await lookup(endpoint.hostname, { all: true, verbatim: true })).map(({ address }) => address);
  let token: string;
  if (input.mode === "docker-local") {
    invariant(input.authentication.kind === "environment", "local-auth-profile", "Docker-local requires local-bearer-v1");
    invariant(input.authentication.variable === LOCAL_BEARER_ENV, "local-env-selector", "Docker-local environment selector must be exact");
    invariant(input.protectedFile !== undefined, "protected-file-required", "Seedbed protected credential selector is required");
    token = await localToken(input.protectedFile);
  } else {
    invariant(input.authentication.kind === "host-oauth", "remote-auth-profile", "Remote mode requires remote-oauth-v1");
    invariant(input.oauthHost !== undefined, "oauth-host-required", "Host-managed OAuth facility is required");
    const metadata = await input.oauthHost.discover(endpoint);
    invariant(metadata.resource === endpoint.href, "oauth-resource-mismatch", "Protected-resource metadata resource mismatch");
    invariant(metadata.issuer === input.authentication.issuer, "oauth-issuer-mismatch", "OAuth issuer mismatch");
    invariant(metadata.audience === input.authentication.audience, "oauth-audience-mismatch", "OAuth audience mismatch");
    invariant(canonicalJson([...metadata.scopes].sort()) === canonicalJson([...input.authentication.scopes].sort()),
      "oauth-scope-mismatch", "OAuth scopes mismatch");
    invariant(metadata.algorithms.every((algorithm) => ["ES256", "EdDSA", "RS256"].includes(algorithm)),
      "oauth-algorithm-denied", "OAuth metadata contains an unsupported algorithm");
    invariant(metadata.authorizationServers.length === 1, "oauth-selector-ambiguous", "OAuth authorization server is ambiguous");
    const descriptor = await input.oauthHost.authorize(input.authentication, metadata);
    token = await input.oauthHost.accessToken(descriptor.descriptorId);
    invariant(token.length > 0, "oauth-token-unavailable", "Host OAuth facility returned no access token");
  }

  await assertDnsStable(endpoint, originalAddresses);
  const transport = input.transport ?? new FetchWorkshopTransport();
  const initialized = await transport.call(endpoint, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "alembic-verifier", version: "0.1.0" }
  });
  const init = initialized.response.result as {
    protocolVersion?: string;
    serverInfo?: { name?: string };
  };
  invariant(init.serverInfo?.name === WORKSHOP_IDENTITY, "wrong-server-identity", "MCP server identity is not exactly gnolith");
  invariant(typeof init.protocolVersion === "string", "invalid-initialize", "Workshop initialize response is incomplete");
  await assertDnsStable(endpoint, originalAddresses);
  const catalogResponse = await transport.call(endpoint, token, "tools/list", {}, initialized.sessionId);
  const catalog = catalogResponse.response.result as { tools?: { name?: string }[] };
  invariant(Array.isArray(catalog.tools), "invalid-catalog", "Workshop tools/list response is invalid");
  const tools = catalog.tools.map((tool) => tool.name).filter((name): name is string => typeof name === "string");
  invariant(tools.includes("gnolith_status"), "status-tool-missing", "Workshop catalog lacks gnolith_status");
  invariant(
    !tools.some((name) => /(?:alembic|seedbed|setup)/iu.test(name)),
    "control-plane-tool-in-workshop",
    "Workshop catalog advertises a setup control-plane tool"
  );
  invariant(new Set(tools).size === tools.length, "duplicate-catalog", "Workshop catalog contains duplicate tool identities");
  const statusResponse = await transport.call(
    endpoint,
    token,
    "tools/call",
    { name: "gnolith_status", arguments: {} },
    initialized.sessionId
  );
  const statusResult = statusResponse.response.result as { structuredContent?: WorkshopStatusOutput };
  invariant(statusResult.structuredContent !== undefined, "invalid-status", "gnolith_status lacks structured content");
  compareStatus(statusResult.structuredContent, input.expected);
  const digest = sha256(canonicalJson({ identity: WORKSHOP_IDENTITY, tools, status: statusResult.structuredContent }));
  token = "";
  return {
    identity: WORKSHOP_IDENTITY,
    protocolVersion: init.protocolVersion,
    tools,
    status: statusResult.structuredContent,
    digest
  };
}
