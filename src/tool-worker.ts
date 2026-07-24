import { parentPort, workerData } from "node:worker_threads";
import { AlembicControlPlane } from "./control-plane.js";
import { publicError } from "./canonical.js";
import { loadDefaultSeedbedFactory } from "./seedbed.js";
import type { PlanRequest } from "./types.js";
import type { IsolatedToolOperation } from "./tool-isolation.js";

interface WorkerInput {
  operation: IsolatedToolOperation;
  input: unknown;
}

const channel = parentPort;
if (channel === null) throw new Error("Alembic tool worker requires a parent channel");
const request = workerData as WorkerInput;
let stage = "worker-start";

try {
  if (request.operation !== "legacy-inspect") {
    stage = "seedbed-load";
    channel.postMessage({ kind: "stage", stage });
  }
  const seedbedFactory = request.operation === "legacy-inspect"
    ? undefined
    : await loadDefaultSeedbedFactory().catch(() => undefined);
  const control = new AlembicControlPlane({
    ...(seedbedFactory === undefined ? {} : { seedbedFactory }),
    phaseObserver(nextStage) {
      stage = nextStage;
      channel.postMessage({ kind: "stage", stage });
    }
  });
  let value: unknown;
  if (request.operation === "plan") {
    value = await control.plan(request.input as PlanRequest);
  } else if (request.operation === "legacy-inspect") {
    value = await control.legacyInspect(
      request.input as Parameters<typeof control.legacyInspect>[0]
    );
  } else {
    value = await control.legacyAdopt(
      request.input as Parameters<typeof control.legacyAdopt>[0]
    );
  }
  channel.postMessage({ kind: "result", value });
} catch (error) {
  const safe = publicError(error);
  channel.postMessage({ kind: "error", code: safe.code, stage, details: safe.details });
}
