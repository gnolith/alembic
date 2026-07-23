import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./canonical.js";
import { invariant } from "./errors.js";
import {
  BEGIN_MARKER,
  END_MARKER,
  LOCAL_BEARER_ENV,
  type EnvironmentSelector,
  type HostOAuthSelector
} from "./types.js";

export type ManagedState = "absent" | "complete" | "invalid" | "user-owned";

export interface ConfigInspection {
  state: ManagedState;
  digest: string | null;
  block: string | null;
  endpoint: string | null;
}

const TABLE = /^\s*\[mcp_servers\.gnolith\]\s*$/gmu;

export function inspectConfigText(text: string): ConfigInspection {
  const starts = [...text.matchAll(new RegExp(escapeRegex(BEGIN_MARKER), "gu"))];
  const ends = [...text.matchAll(new RegExp(escapeRegex(END_MARKER), "gu"))];
  const tables = [...text.matchAll(TABLE)];
  if (starts.length === 0 && ends.length === 0) {
    return {
      state: tables.length > 0 ? "user-owned" : "absent",
      digest: sha256(text),
      block: null,
      endpoint: null
    };
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index! >= ends[0]!.index! || tables.length !== 1) {
    return { state: "invalid", digest: sha256(text), block: null, endpoint: null };
  }
  const begin = starts[0]!.index!;
  const end = ends[0]!.index! + END_MARKER.length;
  const block = text.slice(begin, end);
  if (!block.includes("[mcp_servers.gnolith]")) {
    return { state: "invalid", digest: sha256(text), block, endpoint: null };
  }
  const endpoint = block.match(/^url = "([^"\r\n]+)"$/mu)?.[1] ?? null;
  return { state: endpoint ? "complete" : "invalid", digest: sha256(text), block, endpoint };
}

export async function inspectConfig(path: string): Promise<ConfigInspection> {
  try {
    const info = await lstat(path);
    invariant(info.isFile() && !info.isSymbolicLink(), "unsafe-config", "Config must be a regular non-link file");
    return inspectConfigText(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent", digest: null, block: null, endpoint: null };
    }
    throw error;
  }
}

export function renderManagedBlock(
  endpoint: string,
  authentication: EnvironmentSelector | HostOAuthSelector
): string {
  const auth =
    authentication.kind === "environment"
      ? `bearer_token_env_var = "${LOCAL_BEARER_ENV}"`
      : 'auth = "oauth"';
  return [
    BEGIN_MARKER,
    "[mcp_servers.gnolith]",
    `url = "${endpoint}"`,
    auth,
    "required = false",
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
    'default_tools_approval_mode = "writes"',
    END_MARKER
  ].join("\n");
}

export function replaceManagedBlock(
  existing: string,
  block: string,
  action: "upsert" | "remove"
): string {
  const inspection = inspectConfigText(existing);
  invariant(inspection.state !== "invalid", "invalid-managed-block", "Alembic markers are malformed");
  invariant(inspection.state !== "user-owned", "user-owned-gnolith", "A user-owned Gnolith table already exists");
  if (inspection.state === "complete") {
    const begin = existing.indexOf(BEGIN_MARKER);
    const end = existing.indexOf(END_MARKER, begin) + END_MARKER.length;
    const replacement = action === "upsert" ? block : "";
    return normalizeSpacing(existing.slice(0, begin) + replacement + existing.slice(end));
  }
  return action === "upsert" ? normalizeSpacing(`${existing}\n${block}\n`) : existing;
}

function normalizeSpacing(text: string): string {
  return `${text.replace(/\r\n?/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}

export async function atomicConfigWrite(input: {
  path: string;
  expectedDigest: string | null;
  content: string;
}): Promise<string> {
  const before = await inspectConfig(input.path);
  invariant(before.digest === input.expectedDigest, "config-changed", "Codex config changed after planning");
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
  const temp = `${input.path}.alembic-${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(input.content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const recheck = await inspectConfig(input.path);
    invariant(recheck.digest === input.expectedDigest, "config-changed", "Codex config changed during apply");
    await rename(temp, input.path);
    await access(input.path, constants.R_OK);
    return sha256(await readFile(input.path));
  } finally {
    if (handle) await handle.close();
    await rm(temp, { force: true });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
