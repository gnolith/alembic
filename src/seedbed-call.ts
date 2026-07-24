import { AlembicError } from "./errors.js";
import type { SeedbedCallOptions } from "./types.js";

export const SEEDBED_PLAN_DEADLINE_MS = 15_000;
export const SEEDBED_MUTATION_DEADLINE_MS = 30_000;
export const SEEDBED_DIAGNOSE_DEADLINE_MS = 10_000;
export const LEGACY_INSPECT_DEADLINE_MS = 10_000;

export async function boundedSeedbedCall<T>(
  operation: string,
  deadlineMs: number,
  invoke: (options: SeedbedCallOptions) => Promise<T>
): Promise<T> {
  return boundedOperation(
    `seedbed-${operation}`,
    deadlineMs,
    (signal) => invoke({ signal, deadlineMs })
  );
}

export async function boundedOperation<T>(
  operation: string,
  deadlineMs: number,
  invoke: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AlembicError(
        `${operation}-timeout`,
        `${operation} exceeded its bounded deadline`,
        { operation, retryable: true }
      ));
      controller.abort(new Error(`${operation}-deadline`));
    }, deadlineMs);
  });
  const running = Promise.resolve().then(() => invoke(controller.signal));
  running.catch(() => undefined);
  try {
    return await Promise.race([running, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
