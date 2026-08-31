export class ChatError extends Error {
  override name = "ChatError";
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "ALREADY_EXISTS" | "CONFIG_INVALID" | "STORE_ERROR" | "VALIDATION_ERROR",
    public readonly cause_?: unknown,
  ) {
    super(message);
  }
}

export class ChatConfigError extends ChatError {
  override name = "ChatConfigError";
  constructor(message: string, cause?: unknown) {
    super(message, "CONFIG_INVALID", cause);
  }
}
