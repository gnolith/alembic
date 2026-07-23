import { lstat, readFile, realpath } from "node:fs/promises";
import { applyPlan, resumeOperation, type ApplyDependencies } from "./apply.js";
import { inspectConfig } from "./config.js";
import { publicError } from "./canonical.js";
import { invariant } from "./errors.js";
import { inspectLegacyBundle } from "./legacy.js";
import { createPlan } from "./plans.js";
import { attestProject } from "./project.js";
import { OperationStore } from "./store.js";
import type { AlembicPlan, HostMetadataV1, PlanRequest, SeedbedControl } from "./types.js";

export interface ControlPlaneDependencies extends ApplyDependencies {
  seedbed?: SeedbedControl;
}

export class AlembicControlPlane {
  constructor(private readonly dependencies: ControlPlaneDependencies = {}) {}

  async inspect(input: {
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
  }) {
    const project = await attestProject(input);
    const config = await inspectConfig(project.configPath);
    return {
      purpose: "setup-and-diagnostics-only",
      proxy: false,
      project,
      configured: config.state === "complete",
      conflict: config.state === "invalid" || config.state === "user-owned",
      managedState: config.state,
      endpoint: config.endpoint,
      next:
        config.state === "complete"
          ? "Use Workshop directly after activation; diagnose only if unavailable or wrong."
          : config.state === "absent"
            ? "Discover environment and create an approved plan."
            : "Do not overwrite this configuration."
    };
  }

  async discover(input: {
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
  }) {
    const inspection = await this.inspect(input);
    return {
      ...inspection,
      supported: {
        dockerLocal: "Seedbed create/connect/repair",
        remote: "connect-existing with host-managed OAuth"
      },
      unsupported: ["process/stdio", "Codex Sites provisioning", "hosted deployment"],
      requiredChoices: [
        "action",
        "mode",
        "approved Workshop endpoint ending in /mcp",
        "authentication selector",
        "expected installation/status evidence"
      ]
    };
  }

  async plan(request: PlanRequest): Promise<AlembicPlan> {
    return createPlan(request, this.dependencies.seedbed);
  }

  async apply(input: {
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
    planId: string;
  }) {
    const project = await attestProject(input);
    const plan = await new OperationStore(project.root).readPlan(input.planId);
    invariant(plan.project.identity === project.identity, "plan-scope-mismatch", "Current project attestation does not match the plan");
    return applyPlan(plan, this.dependencies);
  }

  async operationRead(input: {
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
    operationId: string;
  }) {
    const project = await attestProject(input);
    return new OperationStore(project.root).readReceipt(input.operationId);
  }

  async operationResume(input: {
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
    operationId: string;
  }) {
    const project = await attestProject(input);
    return resumeOperation(project.root, input.operationId, this.dependencies);
  }

  async diagnose(input: {
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
    installationId?: string;
  }) {
    const inspection = await this.inspect(input);
    let seedbed = null;
    if (input.installationId && this.dependencies.seedbed) {
      seedbed = await this.dependencies.seedbed.diagnose({
        installationId: input.installationId,
        projectRoot: inspection.project.root
      });
    }
    return {
      purpose: "bounded-redacted-diagnosis",
      inspection,
      seedbed: seedbed
        ? {
            installationId: seedbed.installationId,
            classification: seedbed.classification,
            restartAllowed: seedbed.restartAllowed
          }
        : null,
      allowedRepair: seedbed?.restartAllowed === true ? "resume-or-restart-recorded-components" : "none",
      forbidden: [
        "migration",
        "restore",
        "delete",
        "credential rotation",
        "authorization broadening",
        "rebind without plan",
        "deployment",
        "proxy"
      ]
    };
  }

  async legacyInspect(input: {
    bundlePath: string;
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
    packageName: string;
    packageVersion: string;
  }) {
    const project = await attestProject(input);
    const bundlePath = await realpath(input.bundlePath);
    const bundleInfo = await lstat(input.bundlePath);
    if (
      bundlePath !== input.bundlePath ||
      bundleInfo.isSymbolicLink() ||
      !bundleInfo.isFile() ||
      !(bundlePath === project.root || bundlePath.startsWith(`${project.root}${process.platform === "win32" ? "\\" : "/"}`))
    ) {
      throw new Error("Legacy bundle must be an exact regular file inside the attested project");
    }
    const bytes = await readFile(input.bundlePath);
    return inspectLegacyBundle({
      bytes,
      packageName: input.packageName,
      packageVersion: input.packageVersion,
      exactTaskRoot: project.root,
      configPath: project.configPath
    });
  }

  async legacyAdopt(input: {
    bundlePath: string;
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
    packageName: string;
    packageVersion: string;
    planRequest?: PlanRequest;
  }) {
    const inspected = await this.legacyInspect(input);
    if (
      (inspected.disposition === "remote-verify" ||
        inspected.disposition === "seedbed-offline-adoption-required") &&
      input.planRequest
    ) {
      return {
        reversible: true,
        originalBundleDigest: inspected.bundle.sha256,
        plan: await createPlan({
          ...input.planRequest,
          action: "adopt",
          legacyHandoff: {
            bundleDigest: inspected.bundle.sha256,
            operationIds: inspected.bundle.receipts.map(({ operationId }) => operationId)
          }
        }, this.dependencies.seedbed)
      };
    }
    return {
      reversible: true,
      originalBundleDigest: inspected.bundle.sha256,
      requiresNewPlan: true,
      requirement:
        inspected.disposition === "seedbed-offline-adoption-required"
          ? "Obtain a successful Seedbed legacy-local-v1 offline adoption receipt, compare all evidence, then create a new Alembic adoption plan."
          : "This obsolete mode requires a new supported Alembic plan."
    };
  }

  async safeCall<T>(operation: () => Promise<T>): Promise<T | { error: ReturnType<typeof publicError> }> {
    try {
      return await operation();
    } catch (error) {
      return { error: publicError(error) };
    }
  }
}
