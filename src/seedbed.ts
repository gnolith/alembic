import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./canonical.js";
import { invariant } from "./errors.js";
import {
  SEEDBED_LOCAL_BUILD_SELECTOR,
  SEEDBED_LOCAL_BUILD_TRUST
} from "./seedbed-trust.js";
import type { SeedbedControl } from "./types.js";

const SEEDBED_CONTROL_MODULE = "@gnolith/seedbed/local-control";

type SeedbedModule = {
  createDefaultSeedbedControl(options: {
    projectRoot: string;
    stateRoot?: string;
  }): SeedbedControl;
};

export async function loadDefaultSeedbedFactory(): Promise<
  (projectRoot: string, approvedStateRoot?: string) => SeedbedControl
> {
  await attestInstalledSeedbed();
  const loaded = (await import(SEEDBED_CONTROL_MODULE)) as SeedbedModule;
  invariant(
    typeof loaded.createDefaultSeedbedControl === "function",
    "seedbed-contract-missing",
    "Installed Seedbed lacks the exact Alembic local-control adapter"
  );
  return (projectRoot, approvedStateRoot) => {
    const control = loaded.createDefaultSeedbedControl(
      approvedStateRoot === undefined ? { projectRoot } : { projectRoot, stateRoot: approvedStateRoot }
    );
    for (const method of ["inspect", "plan", "apply", "resume", "diagnose"] as const) {
      invariant(typeof control[method] === "function", "seedbed-contract-missing", `Seedbed adapter lacks ${method}`);
    }
    return control;
  };
}

export async function attestInstalledSeedbed(): Promise<void> {
  const moduleUrl = import.meta.resolve(SEEDBED_CONTROL_MODULE);
  const packageRoot = dirname(dirname(fileURLToPath(moduleUrl)));
  const lockPath = join(packageRoot, "seedbed-component-lock.json");
  const canonicalLockPath = await realpath(lockPath);
  invariant(canonicalLockPath === lockPath, "seedbed-component-lock-alias", "Seedbed component lock uses a path alias");
  const metadata = await lstat(lockPath);
  invariant(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1024 * 1024,
    "seedbed-component-lock-file",
    "Seedbed component lock is not a bounded regular file"
  );
  const bytes = await readFile(lockPath);
  invariant(
    sha256(bytes) === SEEDBED_LOCAL_BUILD_TRUST.localBuild.componentLockSha256,
    "seedbed-component-lock-digest",
    "Installed Seedbed component lock differs from the pinned candidate"
  );
  const parsed = JSON.parse(bytes.toString("utf8")) as { format?: unknown; localBuildSelector?: unknown };
  invariant(
    parsed.format === "gnolith-seedbed-component-lock-v1" &&
      parsed.localBuildSelector === SEEDBED_LOCAL_BUILD_SELECTOR,
    "seedbed-component-lock-selector",
    "Installed Seedbed component lock has another local-build selector"
  );
}
