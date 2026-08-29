import { logger } from "./logger.ts";

function main(): void {
  // Required by spec: print Hello World
  logger.info("Hello World");

  // Demo other levels (comment out if you want only Hello World)
  // These show color differences for each level:
  // logger.debug("This is a debug message - verbose details");
  // logger.warn("This is a warning - something to pay attention to");
  // logger.error("This is an error - something went wrong");
}

// Ensure we only run when executed directly (Bun supports import.meta.main)
if (import.meta.main) {
  main();
}

export { main };
