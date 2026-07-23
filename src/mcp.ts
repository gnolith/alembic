#!/usr/bin/env node
import { createInterface } from "node:readline";
import { AlembicControlPlane } from "./control-plane.js";
import { invariant } from "./errors.js";
import { publicError } from "./canonical.js";
import { TOOL_CATALOG } from "./tool-catalog.js";
import type { PlanRequest } from "./types.js";
import { loadDefaultSeedbedFactory } from "./seedbed.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const seedbedFactory = await loadDefaultSeedbedFactory().catch(() => undefined);
const control = new AlembicControlPlane(seedbedFactory ? { seedbedFactory } : {});
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
    const result = await handle(request);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result }) + "\n");
  } catch (error) {
    const safe = publicError(error);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: safe.message, data: { classification: safe.code } }
      }) + "\n"
    );
  }
}

async function handle(request: JsonRpcRequest): Promise<unknown> {
  if (request.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "alembic", version: "0.1.0" },
      instructions:
        "Alembic is setup/diagnostics only, never a proxy or Gnolith data plane. After activation, ordinary work uses Workshop directly. Every mutation is project-attested, plan-bound, and config-last."
    };
  }
  if (request.method === "tools/list") return { tools: TOOL_CATALOG };
  if (request.method === "notifications/initialized") return {};
  invariant(request.method === "tools/call", "method-not-found", "Only fixed Alembic MCP operations are available");
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  invariant(TOOL_CATALOG.some((tool) => tool.name === name), "tool-not-found", "Unknown Alembic control-plane tool");
  const definition = TOOL_CATALOG.find((tool) => tool.name === name);
  invariant(
    definition !== undefined && Object.keys(args).every((key) => key in definition.inputSchema.properties),
    "unapproved-input",
    "Tool input contains an unapproved field"
  );
  switch (name) {
    case "alembic_inspect":
      return content(await control.inspect(args as Parameters<typeof control.inspect>[0]));
    case "alembic_discover":
      return content(await control.discover(args as Parameters<typeof control.discover>[0]));
    case "alembic_plan":
      return content(await control.plan(args.request as PlanRequest));
    case "alembic_apply":
      return content(await control.apply(args as Parameters<typeof control.apply>[0]));
    case "alembic_operation_read":
      return content(await control.operationRead(args as Parameters<typeof control.operationRead>[0]));
    case "alembic_operation_resume":
      return content(await control.operationResume(args as Parameters<typeof control.operationResume>[0]));
    case "alembic_diagnose":
      return content(await control.diagnose(args as Parameters<typeof control.diagnose>[0]));
    case "alembic_legacy_inspect":
      return content(await control.legacyInspect(args as Parameters<typeof control.legacyInspect>[0]));
    case "alembic_legacy_adopt":
      return content(await control.legacyAdopt(args as Parameters<typeof control.legacyAdopt>[0]));
    default:
      throw new Error("Tool catalog exhaustiveness failure");
  }
}

function content(value: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false
  };
}
