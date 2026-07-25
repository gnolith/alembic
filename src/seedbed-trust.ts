import { canonicalJson } from "./canonical.js";
import { invariant } from "./errors.js";
import type { SeedbedLocalBuildTrust } from "./types.js";

export const SEEDBED_LOCAL_BUILD_SELECTOR = "gnolith-seedbed-local-build-v1";

export const SEEDBED_LOCAL_BUILD_SELECTION = Object.freeze({
  kind: "seedbed-local-build-v1",
  selector: SEEDBED_LOCAL_BUILD_SELECTOR,
  pullPolicy: "never",
  componentLockSha256: "eb28cb988b0c507d5c9ef4242ec13895af2c8cd8f2c57ba722d01eb89b55ed7d",
  graphSha256: "e400df1282ea7bb395a634abd267936137ab358091afb6cfa37618ccc4c75909",
  composeBundleSha256: "5d5d9aab98e21a019f551b36f28fe8fcacb4f2183ab2cdef1350e6b3185a2a52"
} as const);

export const SEEDBED_LOCAL_BUILD_TRUST: SeedbedLocalBuildTrust = Object.freeze({
  format: "gnolith-alembic-seedbed-local-build-trust-v1",
  seedbedCandidateSha256: "fd3551379ab667006fa5615759096716fc63ba779b15501288132c095c899789",
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
