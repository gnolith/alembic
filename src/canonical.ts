import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, parse, resolve } from "node:path";
import { AlembicError, invariant } from "./errors.js";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key.normalize("NFC"), normalizeValue(record[key])])
    );
  }
  return value;
}

export async function canonicalDirectory(path: string): Promise<string> {
  invariant(path.length > 0 && isAbsolute(path), "invalid-path", "Path must be absolute");
  invariant(path === path.normalize("NFC"), "noncanonical-unicode", "Path must be NFC");
  const resolved = resolve(path);
  invariant(normalize(path) === resolved, "path-traversal", "Path must already be normalized");
  const canonical = await realpath(resolved);
  const info = await stat(canonical);
  invariant(info.isDirectory(), "not-directory", "Project root is not a directory");
  if (process.platform === "win32") {
    invariant(!canonical.startsWith("\\\\"), "unc-denied", "UNC project roots are unsupported");
    invariant(parse(canonical).root.length > 0, "invalid-drive", "Project root has no drive");
  }
  invariant(
    canonical.localeCompare(resolved, undefined, { sensitivity: "accent" }) === 0,
    "link-or-case-alias",
    "Project root must not use a symlink, junction, or case alias"
  );
  return canonical.normalize("NFC");
}

export function operationId(): string {
  return `op_${randomUUID()}`;
}

export function planId(): string {
  return `plan_${randomUUID()}`;
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[redacted]@")
      .replace(/\b(?:bearer|token|password|secret)\s+[A-Za-z0-9._~+/=-]+/giu, "[redacted]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (/(token|password|secret|authorization|credentialValue)/iu.test(key)) {
          return [key, "[redacted]"];
        }
        return [key, redact(item)];
      })
    );
  }
  return value;
}

export function publicError(error: unknown): AlembicError {
  if (error instanceof AlembicError) {
    return new AlembicError(error.code, String(redact(error.message)), redact(error.details) as Record<string, unknown>);
  }
  return new AlembicError("internal", "Alembic operation failed");
}
