import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { canonicalDirectory, sha256 } from "./canonical.js";
import { invariant } from "./errors.js";
import type { HostMetadataV1, ProjectAttestation } from "./types.js";

async function digestOrNull(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    invariant(!info.isSymbolicLink(), "config-link-denied", "Codex config must not be a symlink");
    invariant(info.isFile(), "invalid-config", "Codex config must be a regular file");
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function nearestProjectRoot(taskDirectory: string, confirmedBoundary: string): Promise<string> {
  let cursor = taskDirectory;
  while (true) {
    const candidate = join(cursor, ".codex", "config.toml");
    if ((await digestOrNull(candidate)) !== null) return cursor;
    if (cursor === confirmedBoundary) return confirmedBoundary;
    const parent = dirname(cursor);
    if (parent === cursor || cursor === parse(cursor).root) return taskDirectory;
    cursor = parent;
  }
}

export async function attestProject(input: {
  taskDirectory: string;
  hostMetadata?: HostMetadataV1;
  confirmedProjectRoot?: string;
}): Promise<ProjectAttestation> {
  const taskDirectory = await canonicalDirectory(input.taskDirectory);
  let root: string;
  let metadataVersion: 1 | null = null;
  let trusted = false;
  let confirmedFallback = false;

  if (input.hostMetadata) {
    invariant(input.hostMetadata.version === 1, "unsupported-host-metadata", "Unsupported Codex host metadata");
    const metadataTask = await canonicalDirectory(input.hostMetadata.taskDirectory);
    invariant(metadataTask === taskDirectory, "metadata-task-mismatch", "Host task directory does not match request");
    root = await canonicalDirectory(input.hostMetadata.projectRoot);
    invariant(
      taskDirectory === root || taskDirectory.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`),
      "scope-mismatch",
      "Task directory is outside the attested project root"
    );
    invariant(input.hostMetadata.trusted, "project-untrusted", "Codex does not trust this project");
    invariant(input.hostMetadata.managedPolicy === "allow", "managed-policy-denied", "Managed policy denies setup");
    metadataVersion = 1;
    trusted = true;
  } else {
    invariant(input.confirmedProjectRoot !== undefined, "confirmation-required", "Exact canonical project root confirmation is required");
    root = await canonicalDirectory(input.confirmedProjectRoot);
    invariant(root === input.confirmedProjectRoot, "confirmation-not-canonical", "Confirmed root is not canonical");
    invariant(
      taskDirectory === root || taskDirectory.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`),
      "scope-mismatch",
      "Task directory is outside the confirmed project root"
    );
    const nearest = await nearestProjectRoot(taskDirectory, root);
    invariant(nearest === root, "nearest-config-mismatch", "Confirmed root loses nearest-config precedence");
    confirmedFallback = true;
    trusted = true;
  }

  const configPath = resolve(root, ".codex", "config.toml");
  invariant(configPath.startsWith(root), "config-scope-mismatch", "Config path escaped project root");
  try {
    const codexDirectory = dirname(configPath);
    const info = await lstat(codexDirectory);
    invariant(info.isDirectory() && !info.isSymbolicLink(), "config-parent-link", "Codex config directory is unsafe");
    invariant(await realpath(codexDirectory) === codexDirectory, "config-parent-link", "Codex config directory uses an alias");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configDigest = await digestOrNull(configPath);
  const identity = sha256(`${root}\0${configPath}\0${configDigest ?? "absent"}`);
  return { root, configPath, configDigest, metadataVersion, trusted, confirmedFallback, identity };
}

export async function currentConfigDigest(configPath: string): Promise<string | null> {
  return digestOrNull(configPath);
}
