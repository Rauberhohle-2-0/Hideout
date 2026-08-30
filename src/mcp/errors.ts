export class McpError extends Error {
  override name = "McpError";
  constructor(
    message: string,
    public readonly code:
      | "CONFIG_INVALID"
      | "NOT_FOUND"
      | "ALREADY_EXISTS"
      | "CONNECTION_FAILED"
      | "TIMEOUT"
      | "AUTH_FAILED"
      | "NOT_CONNECTED"
      | "VALIDATION_ERROR"
      | "STORE_ERROR",
    public readonly cause_?: unknown,
  ) {
    super(message);
  }
}

export class McpConfigError extends McpError {
  override name = "McpConfigError";
  constructor(message: string, cause?: unknown) {
    super(message, "CONFIG_INVALID", cause);
  }
}
