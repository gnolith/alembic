import { canonicalJson } from "./canonical.js";
import { invariant } from "./errors.js";
import type { SeedbedLocalBuildTrust } from "./types.js";

export const SEEDBED_LOCAL_BUILD_SELECTOR = "gnolith-seedbed-local-build-v1";

export const SEEDBED_LOCAL_BUILD_SELECTION = Object.freeze({
  kind: "seedbed-local-build-v1",
  selector: SEEDBED_LOCAL_BUILD_SELECTOR,
  pullPolicy: "never",
  componentLockSha256: "1f32ff319bc4094d3b91f38c8d89db1cf27b4b7c466b89437c3e79a644688d6c",
  graphSha256: "2376959c697e63ac1deb674a1e7bfe2b2f4fd117173334d74f8cc3f7255046c7",
  composeBundleSha256: "696fcebfdd429b4e71b04a9f48d6c8dd500cfdde1a16db1bcd0fc582108d76a8"
} as const);

export const SEEDBED_LOCAL_BUILD_TRUST: SeedbedLocalBuildTrust = Object.freeze({
  format: "gnolith-alembic-seedbed-local-build-trust-v1",
  seedbedCandidateSha256: "5c4850628f8d7c24ca8b9b7844f1d43bc4347c3ad1df56d672c7f4d210510284",
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
