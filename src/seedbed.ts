import { invariant } from "./errors.js";
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
