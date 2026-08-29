export class AiError extends Error {
  override name = "AiError";
  constructor(
    message: string,
    public readonly code:
      | "CONFIG_INVALID"
      | "NOT_FOUND"
      | "AUTH_FAILED"
      | "TIMEOUT"
      | "RATE_LIMITED"
      | "UPSTREAM_ERROR"
      | "ABORTED"
      | "VALIDATION_ERROR"
      | "NOT_IMPLEMENTED",
    public readonly cause_?: unknown,
  ) {
    super(message);
  }
}

export class AiConfigError extends AiError {
  override name = "AiConfigError";
  constructor(message: string, cause?: unknown) {
    super(message, "CONFIG_INVALID", cause);
  }
}

export class AiUpstreamError extends AiError {
  override name = "AiUpstreamError";
  constructor(message: string, cause?: unknown) {
    super(message, "UPSTREAM_ERROR", cause);
  }
}
