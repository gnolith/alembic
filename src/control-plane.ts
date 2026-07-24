import { lstat, readFile, realpath } from "node:fs/promises";
import { applyPlan, type ApplyDependencies } from "./apply.js";
import { inspectConfig } from "./config.js";
import { publicError } from "./canonical.js";
import { invariant } from "./errors.js";
import { inspectLegacyBundle } from "./legacy.js";
import { createPlan } from "./plans.js";
import { attestProject } from "./project.js";
import { OperationStore } from "./store.js";
import {
  boundedOperation,
  boundedSeedbedCall,
  LEGACY_INSPECT_DEADLINE_MS,
  SEEDBED_DIAGNOSE_DEADLINE_MS,
  SEEDBED_PLAN_DEADLINE_MS
} from "./seedbed-call.js";
import type { AlembicPlan, HostMetadataV1, PlanRequest, SeedbedControl } from "./types.js";

export interface ControlPlaneDependencies extends ApplyDependencies {
  seedbed?: SeedbedControl;
  seedbedFactory?: (projectRoot: string, approvedStateRoot?: string) => SeedbedControl;
  planDeadlineMs?: number;
  diagnoseDeadlineMs?: number;
  legacyInspectDeadlineMs?: number;
  phaseObserver?: (stage: string) => void;
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
    this.dependencies.phaseObserver?.("project-attestation");
    const project = await attestProject(request);
    this.dependencies.phaseObserver?.("seedbed-plan");
    return createPlan(
      request,
      this.seedbedFor(project.root, request.seedbedStateRoot),
      this.dependencies.planDeadlineMs ?? SEEDBED_PLAN_DEADLINE_MS,
      this.dependencies.phaseObserver
    );
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
    return applyPlan(plan, this.applyDependencies(project.root, plan.seedbedStateRoot ?? undefined));
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
    const store = new OperationStore(project.root);
    const receipt = await store.readReceipt(input.operationId);
    const plan = await store.readPlan(receipt.planId);
    return applyPlan(plan, this.applyDependencies(project.root, plan.seedbedStateRoot ?? undefined), true);
  }

  async diagnose(input: {
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
    installationId?: string;
    operationId?: string;
    seedbedStateRoot?: string;
  }) {
    const inspection = await this.inspect(input);
    let operation = null;
    let expectedIdentity = null;
    if (input.operationId) {
      operation = await new OperationStore(inspection.project.root).readReceipt(input.operationId);
      const plan = await new OperationStore(inspection.project.root).readPlan(operation.planId);
      expectedIdentity = {
        installationId: plan.expected.installationId,
        baseIri: plan.expected.baseIri,
        catalogDigest: plan.expected.catalogDigest,
        serverVersion: plan.expected.serverVersion,
        operationVersion: plan.expected.operationVersion
      };
    }
    let seedbed = null;
    let seedbedTimedOut = false;
    const seedbedControl = this.seedbedFor(inspection.project.root, input.seedbedStateRoot);
    if (input.installationId && seedbedControl) {
      const installationId = input.installationId;
      try {
        seedbed = await boundedSeedbedCall(
          "diagnose",
          this.dependencies.diagnoseDeadlineMs ?? SEEDBED_DIAGNOSE_DEADLINE_MS,
          (options) => seedbedControl.diagnose({
            installationId,
            projectRoot: inspection.project.root
          }, options)
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "seedbed-diagnose-timeout") {
          seedbedTimedOut = true;
        } else {
          throw error;
        }
      }
    }
    const seedbedStopped = seedbed !== null &&
      (seedbed.classification === "local-workshop-unavailable" ||
        (seedbed.classification.startsWith("local-installation-") &&
          seedbed.classification !== "local-installation-ready"));
    return {
      format: "gnolith-alembic-diagnostic-v1",
      purpose: "bounded-redacted-diagnosis",
      classification:
        operation?.failureClassification === "workshop-stopped"
          ? "workshop-stopped"
          : operation?.failureClassification === "repair-failed"
            ? "repair-failed"
          : operation?.failureClassification === "seedbed-timeout" || seedbedTimedOut
            ? "seedbed-timeout"
          : seedbedStopped
            ? "workshop-stopped"
        : inspection.conflict
          ? "config-conflict"
          : operation?.state === "activation-required" || operation?.state === "activation-prerequisite"
            ? "activation-pending"
            : inspection.configured
              ? "ready"
              : "unknown",
      projectRoot: inspection.project.root,
      managedState: inspection.managedState,
      expectedIdentity,
      observedIdentity:
        operation?.verificationDigest
          ? { verificationDigest: operation.verificationDigest, verifiedBeforeConfigWrite: true }
          : null,
      activationPending:
        operation?.state === "activation-required" || operation?.state === "activation-prerequisite",
      repair:
        operation?.state === "failed" ||
          operation?.state === "activation-prerequisite" ||
          (seedbedTimedOut && operation?.seedbed != null)
          ? "resume-exact-operation"
          : seedbed?.repair?.kind === "seedbed-resume-operation-v1" &&
              seedbed.repair.action === "restart-recorded-compose" &&
              operation?.seedbed?.operationId === seedbed.repair.operationId
            ? "resume-exact-operation"
            : "none",
      seedbed: seedbedTimedOut && input.installationId
        ? {
            installationId: input.installationId,
            classification: "timeout",
            repairBound: operation?.seedbed !== null
          }
        : seedbed
        ? {
            installationId: seedbed.installationId,
            classification: seedbed.classification,
            repairBound:
              seedbed.repair?.kind === "seedbed-resume-operation-v1" &&
              seedbed.repair.action === "restart-recorded-compose" &&
              operation?.seedbed?.operationId === seedbed.repair.operationId
          }
        : null,
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
    this.dependencies.phaseObserver?.("legacy-deadline");
    return boundedOperation(
      "legacy-inspect",
      this.dependencies.legacyInspectDeadlineMs ?? LEGACY_INSPECT_DEADLINE_MS,
      () => this.inspectLegacyInput(input)
    );
  }

  private async inspectLegacyInput(input: {
    bundlePath: string;
    taskDirectory: string;
    confirmedProjectRoot?: string;
    hostMetadata?: HostMetadataV1;
    packageName: string;
    packageVersion: string;
  }) {
    this.dependencies.phaseObserver?.("legacy-project-attestation");
    const project = await attestProject(input);
    this.dependencies.phaseObserver?.("legacy-bundle-scope");
    const bundlePath = await realpath(input.bundlePath);
    const bundleInfo = await lstat(input.bundlePath);
    invariant(
      !(
      bundlePath !== input.bundlePath ||
      bundleInfo.isSymbolicLink() ||
      !bundleInfo.isFile() ||
      !(bundlePath === project.root || bundlePath.startsWith(`${project.root}${process.platform === "win32" ? "\\" : "/"}`))
      ),
      "legacy-bundle-scope",
      "Legacy bundle must be an exact regular file inside the attested project"
    );
    this.dependencies.phaseObserver?.("legacy-bundle-read");
    const bytes = await readFile(input.bundlePath);
    this.dependencies.phaseObserver?.("legacy-bundle-validate");
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
        }, this.dependencies.seedbed, this.dependencies.planDeadlineMs ?? SEEDBED_PLAN_DEADLINE_MS)
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

  private seedbedFor(projectRoot: string, approvedStateRoot?: string): SeedbedControl | undefined {
    return this.dependencies.seedbedFactory?.(projectRoot, approvedStateRoot) ?? this.dependencies.seedbed;
  }

  private applyDependencies(projectRoot: string, approvedStateRoot?: string): ApplyDependencies {
    const seedbed = this.seedbedFor(projectRoot, approvedStateRoot);
    return {
      ...(seedbed ? { seedbed } : {}),
      ...(this.dependencies.oauthHost ? { oauthHost: this.dependencies.oauthHost } : {}),
      ...(this.dependencies.workshopTransport ? { workshopTransport: this.dependencies.workshopTransport } : {}),
      ...(this.dependencies.seedbedDeadlineMs !== undefined
        ? { seedbedDeadlineMs: this.dependencies.seedbedDeadlineMs }
        : {})
    };
  }
}
