export class AssistantError extends Error {
  override name = "AssistantError";
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "ALREADY_EXISTS" | "CONFIG_INVALID" | "STORE_ERROR" | "VALIDATION_ERROR",
    public readonly cause_?: unknown,
  ) {
    super(message);
  }
}

export class AssistantConfigError extends AssistantError {
  override name = "AssistantConfigError";
  constructor(message: string, cause?: unknown) {
    super(message, "CONFIG_INVALID", cause);
  }
}
