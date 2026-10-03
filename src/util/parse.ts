import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !(value > 0)) {
    return fallback;
  }
  return Math.min(Math.floor(value), 100);
}

export function positiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${name} must be a positive integer when set`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${name} must be a positive integer when set`,
    );
  }
  return value;
}
