import { readFile, lstat, realpath } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isAbsolute, normalize, resolve } from "node:path";
import { canonicalBaseIri, canonicalJson, sha256 } from "./canonical.js";
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
  type SemanticPlanProfileV1,
  type WorkshopStatusOutput,
  type WorkshopVerification
} from "./types.js";

export const WORKSHOP_MIGRATION_SCHEMA_VERSION = 11 as const;
export const WORKSHOP_OPERATION_SCHEMA_VERSION = 2 as const;
export const WORKSHOP_CATALOG_DIGEST =
  "a57799a792a075a5e359567240a7241a48df4155fae3a9e73b092ccf9035955b" as const;
export const WORKSHOP_TOOL_NAMES = [
  "gnolith_status",
  "authorization_admin",
  "search",
  "search_hydrate",
  "search_admin",
  "get_entity",
  "entity_history",
  "statement_history",
  "get_entities",
  "create_item",
  "create_property",
  "mutate_entity",
  "entity_revision",
  "statement_revision",
  "export_entity_json",
  "create_resource",
  "get_resource",
  "update_resource",
  "delete_resource",
  "resource_history",
  "resource_revision",
  "hydrate_resource",
  "create_annotation",
  "get_annotation",
  "update_annotation",
  "delete_annotation",
  "annotation_history",
  "annotation_revision",
  "validate_sparql",
  "query_sparql",
  "list_tasks",
  "search_tasks",
  "get_task",
  "get_task_packet",
  "create_task",
  "update_task",
  "archive_task",
  "claim_task",
  "release_task",
  "complete_task",
  "task_history",
  "list_memories",
  "get_memory",
  "upsert_memory",
  "delete_memory",
  "memory_history",
  "list_prompts",
  "get_prompt",
  "create_prompt",
  "update_prompt",
  "delete_prompt",
  "prompt_history"
] as const;

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
  const token = canonicalBearerSecret(bytes);
  invariant(sha256(token) === selector.sha256, "token-digest-mismatch", "Protected credential digest mismatch");
  invariant(
    process.env[LOCAL_BEARER_ENV] === token,
    "activation-prerequisite",
    "Inject the protected credential into the Codex parent process using an OS/user secret facility, then retry"
  );
  return token;
}

export function canonicalBearerSecret(bytes: Uint8Array): string {
  invariant(bytes.byteLength <= 4096, "token-file-too-large", "Protected credential file exceeds 4 KiB");
  let token: string;
  try {
    token = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invariant(false, "invalid-token-file", "Protected token is not canonical UTF-8 text");
  }
  if (token.endsWith("\n")) token = token.slice(0, -1);
  const hasControlCharacter = [...token].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  invariant(
    token.length > 0 &&
      token === token.normalize("NFC") &&
      token.trim() === token &&
      !hasControlCharacter,
    "invalid-token-file",
    "Protected token must contain one canonical text secret with at most one terminal LF"
  );
  invariant(/^[A-Za-z0-9_-]+$/u.test(token), "invalid-token-file", "Protected token is not canonical base64url text");
  return token;
}

function compareStatus(
  observed: WorkshopStatusOutput,
  expected: ExpectedWorkshopStatus,
  semanticProfile?: SemanticPlanProfileV1
): void {
  let observedBaseIri: string;
  try {
    observedBaseIri = canonicalBaseIri(observed.baseIri);
  } catch {
    invariant(false, "invalid-status-shape", "gnolith_status base IRI is invalid");
  }
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
      exactKeys(observed.semanticState, ["state", "configured", "revision", "fingerprint", "ready"]) &&
      exactKeys(observed.producers, ["ready", "fingerprint", "kinds"]) &&
      exactKeys(observed.versions, ["server", "operationSchema"]) &&
      [observed.installationId, observed.baseIri, observed.principalId, observed.credentialId,
        observed.producers.fingerprint, observed.versions.server].every((value) => typeof value === "string" && value.length > 0) &&
      (observed.activeWorkspaceId === null || (typeof observed.activeWorkspaceId === "string" && observed.activeWorkspaceId.length > 0)) &&
      ["ready", "degraded", "unconfigured"].includes(observed.semanticState.state) &&
      observed.semanticState.configured === (observed.semanticState.state !== "unconfigured") &&
      observed.migrationReadiness.namespace === "@gnolith/workshop" &&
      observed.migrationReadiness.version === WORKSHOP_MIGRATION_SCHEMA_VERSION &&
      observed.versions.operationSchema === WORKSHOP_OPERATION_SCHEMA_VERSION &&
      Number.isInteger(observed.authorizationRevision) &&
      observed.authorizationRevision >= 0 &&
      observed.compatibility.diamond &&
      observed.compatibility.taproot &&
      uniqueStrings(observed.capabilities) &&
      uniqueStrings(observed.producers.kinds) &&
      canonicalJson([...observed.producers.kinds].sort()) === canonicalJson(["memory", "prompt", "task"]) &&
      observed.operationCatalogDigest === WORKSHOP_CATALOG_DIGEST &&
      validSemanticState(observed.semanticState),
    "invalid-status-shape",
    "gnolith_status nested evidence violates the pinned Workshop schema"
  );
  const comparisons: Readonly<Record<string, [unknown, unknown]>> = {
    installationId: [observed.installationId, expected.installationId],
    baseIri: [observedBaseIri, canonicalBaseIri(expected.baseIri)],
    serverVersion: [observed.versions.server, expected.serverVersion],
    operationVersion: [String(observed.migrationReadiness.version), expected.operationVersion],
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
  if (semanticProfile !== undefined) {
    invariant(
      exactKeys(observed.semanticState, ["state", "configured", "revision", "fingerprint", "ready"]) &&
        observed.semanticState.revision === semanticProfile.revision &&
        observed.semanticState.fingerprint === semanticProfile.fingerprint &&
        observed.semanticState.state ===
          (expected.semanticState === "absent" ? "unconfigured" : expected.semanticState) &&
        observed.semanticState.ready === (observed.semanticState.state === "ready"),
      "semantic-status-mismatch",
      "Workshop semantic fingerprint, revision, or state differs from the approved profile"
    );
    invariant(
      semanticProfile.providerKind !== "ollama-compatible" ||
        observed.semanticState.state !== "ready",
      "semantic-ollama-artifact-unavailable",
      "Ollama semantics cannot be verified ready without an immutable model artifact"
    );
  }
}

function validSemanticState(value: WorkshopStatusOutput["semanticState"]): boolean {
  if (value.state === "unconfigured") {
    return value.configured === false &&
      value.revision === null &&
      value.fingerprint === null &&
      value.ready === false;
  }
  return value.configured === true &&
    Number.isInteger(value.revision) &&
    value.revision !== null &&
    value.revision >= 1 &&
    value.revision <= 1_000_000 &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{64}$/u.test(value.fingerprint) &&
    value.ready === (value.state === "ready");
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
  semanticProfile?: SemanticPlanProfileV1;
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
  invariant(
    canonicalJson(tools) === canonicalJson(WORKSHOP_TOOL_NAMES),
    "workshop-catalog-mismatch",
    "Workshop tools/list differs from the pinned 52-operation catalog"
  );
  const statusResponse = await transport.call(
    endpoint,
    token,
    "tools/call",
    { name: "gnolith_status", arguments: {} },
    initialized.sessionId
  );
  const statusResult = statusResponse.response.result as { structuredContent?: WorkshopStatusOutput };
  invariant(statusResult.structuredContent !== undefined, "invalid-status", "gnolith_status lacks structured content");
  compareStatus(statusResult.structuredContent, input.expected, input.semanticProfile);
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
