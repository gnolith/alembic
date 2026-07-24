import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { AlembicError } from "./errors.js";

export type IsolatedToolOperation = "plan" | "legacy-inspect" | "legacy-adopt";

const TOOL_DEADLINES: Readonly<Record<IsolatedToolOperation, number>> = {
  plan: 10_000,
  "legacy-inspect": 8_000,
  "legacy-adopt": 10_000
};

export async function runIsolatedTool(
  operation: IsolatedToolOperation,
  input: unknown,
  testOptions?: {
    deadlineMs?: number;
    workerUrl?: URL;
  }
): Promise<unknown> {
  const worker = new Worker(fileURLToPath(testOptions?.workerUrl ?? new URL("./tool-worker.js", import.meta.url)), {
    workerData: { operation, input }
  });
  let stage = "worker-start";
  let settled = false;
  return new Promise((resolve, reject) => {
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new AlembicError(
        `${operation}-timeout`,
        `${operation} exceeded its bounded tool deadline`,
        { operation, stage, retryable: true }
      )));
    }, testOptions?.deadlineMs ?? TOOL_DEADLINES[operation]);
    worker.on("message", (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.kind === "stage" && typeof message.stage === "string") {
        stage = boundedStage(message.stage);
        return;
      }
      if (message.kind === "result") {
        finish(() => resolve(message.value));
        return;
      }
      if (message.kind === "error") {
        const code = typeof message.code === "string" ? boundedStage(message.code) : `${operation}-failed`;
        const errorStage = typeof message.stage === "string" ? boundedStage(message.stage) : stage;
        finish(() => reject(new AlembicError(code, `${operation} failed safely`, {
          operation,
          stage: errorStage,
          retryable: false
        })));
      }
    });
    worker.once("error", () => {
      finish(() => reject(new AlembicError(`${operation}-worker`, `${operation} worker failed safely`, {
        operation,
        stage,
        retryable: true
      })));
    });
    worker.once("exit", (code) => {
      if (settled) return;
      finish(() => reject(new AlembicError(`${operation}-worker-exit`, `${operation} worker exited before a result`, {
        operation,
        stage,
        exitCode: code,
        retryable: true
      })));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedStage(value: string): string {
  return /^[a-z0-9-]{1,64}$/u.test(value) ? value : "invalid-stage";
}
