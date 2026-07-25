import { canonicalJson } from "./canonical.js";
import { invariant } from "./errors.js";
import type { SeedbedLocalBuildTrust } from "./types.js";

export const SEEDBED_LOCAL_BUILD_SELECTOR = "gnolith-seedbed-local-build-v1";

export const SEEDBED_LOCAL_BUILD_SELECTION = Object.freeze({
  kind: "seedbed-local-build-v1",
  selector: SEEDBED_LOCAL_BUILD_SELECTOR,
  pullPolicy: "never",
  componentLockSha256: "fc4577d1b58d8dd015fdd851f08b0ce9554959d6bb818d2e481403aa63875256",
  graphSha256: "c4806034c18971a838190a2e9a41fe02ec5b5b64e93ea2300a182fdce2353657",
  composeBundleSha256: "19f98929d597ce8634847eebda27cde5ff9b7a446c522acd4d2b28851d0de06c"
} as const);

export const SEEDBED_LOCAL_BUILD_TRUST: SeedbedLocalBuildTrust = Object.freeze({
  format: "gnolith-alembic-seedbed-local-build-trust-v1",
  seedbedCandidateSha256: "4575ca4d049bcb826812d7e965140a1a99735854c015af959cf1f09163ad75d6",
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
