import { readFile } from "node:fs/promises";
import { applyPlan, resumeOperation, type ApplyDependencies } from "./apply.js";
import { inspectConfig } from "./config.js";
import { publicError } from "./canonical.js";
import { inspectLegacyBundle } from "./legacy.js";
import { createPlan } from "./plans.js";
import { attestProject } from "./project.js";
import { OperationStore } from "./store.js";
import type {
  AlembicPlan,
  HostMetadataV1,
  LegacyHandoffBundle,
  PlanRequest,
  SeedbedControl
} from "./types.js";

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

  async apply(input: { projectRoot: string; planId: string }) {
    const plan = await new OperationStore(input.projectRoot).readPlan(input.planId);
    return applyPlan(plan, this.dependencies);
  }

  async operationRead(input: { projectRoot: string; operationId: string }) {
    return new OperationStore(input.projectRoot).readReceipt(input.operationId);
  }

  async operationResume(input: { projectRoot: string; operationId: string }) {
    return resumeOperation(input.projectRoot, input.operationId, this.dependencies);
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
      seedbed,
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
    configPath: string;
    packageName: string;
    packageVersion: string;
  }) {
    const bytes = await readFile(input.bundlePath);
    return inspectLegacyBundle({
      bytes,
      packageName: input.packageName,
      packageVersion: input.packageVersion,
      exactTaskRoot: input.taskDirectory,
      configPath: input.configPath
    });
  }

  async legacyAdopt(input: {
    inspected: { bundle: LegacyHandoffBundle; disposition: string };
    planRequest?: PlanRequest;
  }) {
    if (
      (input.inspected.disposition === "remote-verify" ||
        input.inspected.disposition === "seedbed-offline-adoption-required") &&
      input.planRequest
    ) {
      return {
        reversible: true,
        originalBundleDigest: input.inspected.bundle.sha256,
        plan: await createPlan({ ...input.planRequest, action: "adopt" }, this.dependencies.seedbed)
      };
    }
    return {
      reversible: true,
      originalBundleDigest: input.inspected.bundle.sha256,
      requiresNewPlan: true,
      requirement:
        input.inspected.disposition === "seedbed-offline-adoption-required"
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
