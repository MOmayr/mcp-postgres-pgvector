import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/** Safely extract a message string from an unknown thrown value. */
export function getErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function wrapDbError(prefix: string, error: unknown): never {
  if (error instanceof McpError) {
    throw error;
  }
  throw new McpError(
    ErrorCode.InternalError,
    `${prefix}: ${getErrorMessage(error)}`,
  );
}
