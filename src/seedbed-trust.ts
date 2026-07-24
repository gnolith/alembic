import { canonicalJson } from "./canonical.js";
import { invariant } from "./errors.js";
import type { SeedbedLocalBuildTrust } from "./types.js";

export const SEEDBED_LOCAL_BUILD_SELECTOR = "gnolith-seedbed-local-build-v1";

export const SEEDBED_LOCAL_BUILD_SELECTION = Object.freeze({
  kind: "seedbed-local-build-v1",
  selector: SEEDBED_LOCAL_BUILD_SELECTOR,
  pullPolicy: "never",
  componentLockSha256: "4bf9259d44495372f70420f5e235b3e12319c5f8be2a8cfff5961a9c89331bfc",
  graphSha256: "9cffdfffa8eb8ae1e961b0b88571c9e6476a7427dcdbd018698e793297ba5be1",
  composeBundleSha256: "f25e9e651de83e94ed6d1d5a25bc2446209951400a8190f50726f2c555f4fdb9"
} as const);

export const SEEDBED_LOCAL_BUILD_TRUST: SeedbedLocalBuildTrust = Object.freeze({
  format: "gnolith-alembic-seedbed-local-build-trust-v1",
  seedbedCandidateSha256: "5faf7a2a7957f04e22b4137ca806b2cbf879c07842a7d5dee211e60a1790deda",
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
