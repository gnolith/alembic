import { canonicalJson, redact, sha256 } from "./canonical.js";
import { atomicConfigWrite, inspectConfig, renderManagedBlock, replaceManagedBlock } from "./config.js";
import { AlembicError, invariant } from "./errors.js";
import { currentConfigDigest } from "./project.js";
import { canonicalDirectory } from "./canonical.js";
import { OperationStore } from "./store.js";
import { verifyPlan } from "./plans.js";
import {
  type AlembicPlan,
  type AlembicReceipt,
  type Checkpoint,
  type OAuthHost,
  type SeedbedControl
} from "./types.js";
import { verifyWorkshop, type WorkshopTransport } from "./workshop.js";

export interface ApplyDependencies {
  seedbed?: SeedbedControl;
  oauthHost?: OAuthHost;
  workshopTransport?: WorkshopTransport;
}

function initialReceipt(plan: AlembicPlan): AlembicReceipt {
  const now = new Date().toISOString();
  return {
    format: "gnolith-alembic-operation-v1",
    operationId: plan.operationId,
    planId: plan.planId,
    planDigest: plan.digest,
    state: "applying",
    startedAt: now,
    updatedAt: now,
    checkpoints: [],
    projectRoot: plan.project.root,
    configBeforeDigest: plan.project.configDigest,
    configAfterDigest: null,
    endpoint: plan.endpoint,
    authentication: plan.mode === "docker-local" ? "local-bearer-v1" : "remote-oauth-v1",
    seedbed: null,
    verificationDigest: null,
    previousReceipt: null,
    message: "Apply started"
  };
}

async function checkpoint(
  store: OperationStore,
  receipt: AlembicReceipt,
  step: string,
  phase: Checkpoint["phase"]
): Promise<AlembicReceipt> {
  const updated = {
    ...receipt,
    updatedAt: new Date().toISOString(),
    checkpoints: [...receipt.checkpoints, { step, phase, at: new Date().toISOString() }]
  };
  await store.writeReceipt(updated);
  return updated;
}

export async function applyPlan(
  plan: AlembicPlan,
  dependencies: ApplyDependencies,
  resume = false
): Promise<AlembicReceipt> {
  verifyPlan(plan);
  invariant(await canonicalDirectory(plan.project.root) === plan.project.root,
    "project-moved", "Attested project root moved or changed identity");
  const store = new OperationStore(plan.project.root);
  let receipt: AlembicReceipt;
  if (resume) {
    receipt = await store.readReceipt(plan.operationId);
    invariant(receipt.planDigest === plan.digest, "resume-plan-mismatch", "Operation is bound to another plan");
    if (receipt.state === "activation-required") return receipt;
  } else {
    try {
      receipt = await store.readReceipt(plan.operationId);
      invariant(receipt.planDigest === plan.digest, "operation-replay", "Operation ID was already used by another plan");
      if (receipt.state === "activation-required") return receipt;
      invariant(false, "resume-required", "Interrupted operations must use resume");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      receipt = initialReceipt(plan);
      await store.writeReceipt(receipt);
    }
  }

  invariant(await currentConfigDigest(plan.project.configPath) === plan.project.configDigest,
    "config-changed", "Config digest changed after planning");
  let seedbedReceipt;
  try {
    if (plan.mode === "docker-local" && plan.action !== "remove") {
      receipt = await checkpoint(store, receipt, "seedbed", "before");
      if (plan.action === "adopt") {
        invariant(plan.legacyAdoption !== null, "legacy-offline-adoption", "Legacy adoption receipt is absent");
        seedbedReceipt = {
          operationId: plan.legacyAdoption.operationId,
          state: "ready" as const,
          version: plan.legacyAdoption.version,
          digest: sha256(canonicalJson(plan.legacyAdoption)),
          endpoint: plan.endpoint,
          installationId: plan.legacyAdoption.installationId,
          baseIri: plan.legacyAdoption.baseIri,
          expected: plan.expected,
          protectedTokenFile: plan.legacyAdoption.protectedTokenFile,
          environmentSelector: "GNOLITH_BEARER_TOKEN" as const
        };
      } else {
        invariant(dependencies.seedbed !== undefined && plan.seedbedPlan !== null,
          "seedbed-required", "Seedbed dependency and plan are required");
        seedbedReceipt = resume && receipt.seedbed
          ? await dependencies.seedbed.resume(receipt.seedbed.operationId)
          : await dependencies.seedbed.apply(plan.seedbedPlan);
      }
      invariant(seedbedReceipt.state === "ready", "seedbed-incomplete", "Seedbed did not produce a ready receipt");
      invariant(
        seedbedReceipt.version === (plan.seedbedPlan?.version ?? plan.legacyAdoption?.version),
        "seedbed-version-changed",
        "Seedbed receipt version changed"
      );
      invariant(seedbedReceipt.endpoint === plan.endpoint, "seedbed-endpoint-changed", "Seedbed receipt endpoint changed");
      invariant(seedbedReceipt.installationId === plan.expected.installationId, "seedbed-identity-changed", "Seedbed identity changed");
      invariant(seedbedReceipt.baseIri === plan.expected.baseIri, "seedbed-base-iri-changed", "Seedbed base IRI changed");
      invariant(
        canonicalJson(seedbedReceipt.expected) === canonicalJson(plan.expected),
        "seedbed-readiness-changed",
        "Seedbed expected Workshop evidence changed"
      );
      invariant(
        seedbedReceipt.environmentSelector === "GNOLITH_BEARER_TOKEN",
        "seedbed-environment-selector",
        "Seedbed credential environment selector is incompatible"
      );
      invariant(
        seedbedReceipt.protectedTokenFile.credentialId.length > 0 &&
          /^[0-9a-f]{64}$/u.test(seedbedReceipt.protectedTokenFile.sha256),
        "seedbed-credential-selector",
        "Seedbed protected credential selector is invalid"
      );
      receipt = {
        ...receipt,
        seedbed: {
          version: seedbedReceipt.version,
          digest: seedbedReceipt.digest,
          operationId: seedbedReceipt.operationId
        }
      };
      receipt = await checkpoint(store, receipt, "seedbed", "after");
    }

    if (plan.action !== "remove") {
      receipt = await checkpoint(store, receipt, "workshop-verification", "before");
      const verification = await verifyWorkshop({
        endpoint: plan.endpoint,
        mode: plan.mode,
        authentication: plan.authentication,
        expected: plan.expected,
        ...(seedbedReceipt ? { protectedFile: seedbedReceipt.protectedTokenFile } : {}),
        ...(dependencies.oauthHost ? { oauthHost: dependencies.oauthHost } : {}),
        ...(dependencies.workshopTransport ? { transport: dependencies.workshopTransport } : {})
      });
      receipt = { ...receipt, verificationDigest: verification.digest };
      receipt = await checkpoint(store, receipt, "workshop-verification", "after");
    }

    receipt = await checkpoint(store, receipt, "config-write", "before");
    const before = await inspectConfig(plan.project.configPath);
    invariant(before.digest === plan.project.configDigest, "config-changed", "Config changed before final write");
    const existing = before.digest === null ? "" : await import("node:fs/promises").then(({ readFile }) => readFile(plan.project.configPath, "utf8"));
    const content =
      plan.action === "remove"
        ? replaceManagedBlock(existing, "", "remove")
        : replaceManagedBlock(existing, renderManagedBlock(plan.endpoint, plan.authentication), "upsert");
    const afterDigest = await atomicConfigWrite({
      path: plan.project.configPath,
      expectedDigest: plan.project.configDigest,
      content
    });
    receipt = { ...receipt, configAfterDigest: afterDigest };
    receipt = await checkpoint(store, receipt, "config-write", "after");
    if (plan.action === "adopt") {
      invariant(plan.legacyHandoff !== null, "legacy-handoff-missing", "Adoption plan lacks its original handoff binding");
      receipt = await checkpoint(store, receipt, "legacy-adoption-receipt", "before");
      await store.writeAdoption(plan.operationId, {
        format: "gnolith-alembic-legacy-adoption-v1",
        originalBundleDigest: plan.legacyHandoff.bundleDigest,
        legacyPackage: "@gnolith/codex-plugin@0.2.0",
        legacyOperationIds: plan.legacyHandoff.operationIds,
        alembicPlanId: plan.planId,
        seedbedAdoptionDigest: plan.legacyAdoption ? sha256(canonicalJson(plan.legacyAdoption)) : null,
        configBeforeDigest: plan.project.configDigest,
        configAfterDigest: afterDigest,
        reversible: true,
        createdAt: new Date().toISOString()
      });
      receipt = await checkpoint(store, receipt, "legacy-adoption-receipt", "after");
    }
    receipt = {
      ...receipt,
      state: "activation-required",
      updatedAt: new Date().toISOString(),
      message:
        "Start one new Codex task in this same project. Codex will load .codex/config.toml and connect directly to Gnolith."
    };
    await store.writeReceipt(receipt);
    return receipt;
  } catch (error) {
    const prerequisite = error instanceof AlembicError && error.code === "activation-prerequisite";
    const failed: AlembicReceipt = {
      ...receipt,
      state: prerequisite ? "activation-prerequisite" : "failed",
      updatedAt: new Date().toISOString(),
      message:
        error instanceof AlembicError
          ? String(redact(error.message))
          : "Apply failed; run bounded diagnosis using the operation ID"
    };
    await store.writeReceipt(failed);
    throw error;
  }
}

export async function resumeOperation(
  projectRoot: string,
  operationId: string,
  dependencies: ApplyDependencies
): Promise<AlembicReceipt> {
  const store = new OperationStore(projectRoot);
  const receipt = await store.readReceipt(operationId);
  const plan = await store.readPlan(receipt.planId);
  return applyPlan(plan, dependencies, true);
}

export function operationAuditDigest(receipt: AlembicReceipt): string {
  return sha256(canonicalJson(receipt));
}
