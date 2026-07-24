import { canonicalJson } from "./canonical.js";
import { invariant } from "./errors.js";
import type { SeedbedLocalBuildTrust } from "./types.js";

export const SEEDBED_LOCAL_BUILD_SELECTOR = "gnolith-seedbed-local-build-v1";

export const SEEDBED_LOCAL_BUILD_SELECTION = Object.freeze({
  kind: "seedbed-local-build-v1",
  selector: SEEDBED_LOCAL_BUILD_SELECTOR,
  pullPolicy: "never",
  componentLockSha256: "b96cc5bfb4f73413e12d8cffd13dd8f9f97f3ca8ffffcefcd576176c521f3190",
  graphSha256: "15ad77b7e178bd76f4ea32d1c1570f8d287caf52b6bd87bc286ffd36f2ad34a9",
  composeBundleSha256: "2a0f1e69f9fb2a4aeb8e906c5db3aec091cfcf52d8af0be65088da251d38235a"
} as const);

export const SEEDBED_LOCAL_BUILD_TRUST: SeedbedLocalBuildTrust = Object.freeze({
  format: "gnolith-alembic-seedbed-local-build-trust-v1",
  seedbedCandidateSha256: "6dff7d30c48e9c807dd81bbff9e2f650287b374997764c8e2a543f33232a284f",
  localBuild: SEEDBED_LOCAL_BUILD_SELECTION
});

export function verifySeedbedLocalBuildTrust(value: SeedbedLocalBuildTrust): void {
  invariant(
    canonicalJson(value) === canonicalJson(SEEDBED_LOCAL_BUILD_TRUST),
    "seedbed-local-build-trust-mismatch",
    "Seedbed local-build trust evidence differs from the pinned candidate"
  );
}

export function isDigestQualifiedImage(value: string): boolean {
  return /^[A-Za-z0-9./:_-]+@sha256:[0-9a-f]{64}$/u.test(value);
}
