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
  try {
    return await boundedOperation(
      `seedbed-${operation}`,
      deadlineMs,
      (signal) => invoke({ signal, timeoutMs: deadlineMs })
    );
  } catch (error) {
    if (error instanceof AlembicError) throw error;
    throw new AlembicError(
      "seedbed-control-rejected",
      "SeedbedControl rejected the approved operation",
      {
        operation,
        phase: `seedbed-${operation}`,
        upstream: {
          code: classifySeedbedControlError(error),
          phase: operation
        },
        retryable: false
      }
    );
  }
}

function classifySeedbedControlError(error: unknown): string {
  if (!(error instanceof TypeError)) return "seedbed-control-error";
  switch (error.message) {
    case "Expected Workshop versions or catalog do not match immutable Seedbed policy":
      return "seedbed-request-compatibility";
    case "An installation without semantic configuration must explicitly expect lexical-only operation":
      return "seedbed-request-lexical-acceptance";
    case "Seedbed local endpoint must be credential-free host IPv4 loopback /mcp":
    case "Seedbed local endpoint must include an explicit port":
      return "seedbed-request-endpoint";
    case "Docker installation request local-build attestations do not match immutable Seedbed policy":
      return "seedbed-request-local-build";
    case "Expected Workshop identity does not match installation request":
      return "seedbed-request-identity";
    default:
      return "seedbed-request-invalid";
  }
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
