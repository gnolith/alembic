export class AlembicError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "AlembicError";
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): asserts condition {
  if (!condition) throw new AlembicError(code, message, details);
}
