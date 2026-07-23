import { TOOL_NAMES, type ToolName } from "./types.js";

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties: false;
  };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const scope = {
  taskDirectory: { type: "string", description: "Exact absolute current task directory" },
  confirmedProjectRoot: { type: "string", description: "Exact canonical root confirmation fallback" },
  hostMetadata: { type: "object", description: "Version-gated Codex host metadata v1" }
};
const identifier = (description: string) => ({ type: "string", pattern: "^(?:plan|op)_[0-9a-f-]{36}$", description });

export const TOOL_CATALOG: readonly ToolDefinition[] = [
  definition("alembic_inspect", "Inspect exact project scope and one managed connection.", scope, ["taskDirectory"], true, true),
  definition("alembic_discover", "Discover bounded supported setup choices.", scope, ["taskDirectory"], true, true),
  definition("alembic_plan", "Create a digest-bound expiring setup plan.", {
    request: { type: "object", description: "Typed Alembic plan request; selectors only" }
  }, ["request"], false, false),
  definition("alembic_apply", "Apply one approved plan with config written last.", {
    projectRoot: { type: "string" },
    planId: identifier("Approved plan ID")
  }, ["projectRoot", "planId"], false, true),
  definition("alembic_operation_read", "Read one redacted operation receipt.", {
    projectRoot: { type: "string" },
    operationId: identifier("Operation ID")
  }, ["projectRoot", "operationId"], true, true),
  definition("alembic_operation_resume", "Resume the exact interrupted operation.", {
    projectRoot: { type: "string" },
    operationId: identifier("Operation ID")
  }, ["projectRoot", "operationId"], false, true),
  definition("alembic_diagnose", "Run bounded redacted project/connection diagnosis.", {
    ...scope,
    installationId: { type: "string", maxLength: 256 }
  }, ["taskDirectory"], true, false),
  definition("alembic_legacy_inspect", "Validate an exact Setup 0.2.0 structural handoff bundle.", {
    bundlePath: { type: "string" },
    taskDirectory: { type: "string" },
    configPath: { type: "string" },
    packageName: { const: "@gnolith/codex-plugin" },
    packageVersion: { const: "0.2.0" }
  }, ["bundlePath", "taskDirectory", "configPath", "packageName", "packageVersion"], true, true),
  definition("alembic_legacy_adopt", "Plan reversible adoption after strict legacy inspection.", {
    inspected: { type: "object" },
    planRequest: { type: "object" }
  }, ["inspected"], false, false)
];

function definition(
  name: ToolName,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[],
  readOnlyHint: boolean,
  idempotentHint: boolean
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: {
      readOnlyHint,
      destructiveHint: false,
      idempotentHint,
      openWorldHint: !readOnlyHint
    }
  };
}

if (TOOL_CATALOG.map(({ name }) => name).join("\0") !== TOOL_NAMES.join("\0")) {
  throw new Error("Fixed Alembic tool catalog drifted");
}
