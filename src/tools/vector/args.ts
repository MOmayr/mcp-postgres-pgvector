import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { optionalString } from "../../util/parse.js";
import { quoteIdent } from "../../util/sql.js";
import {
  type IdValue,
  MAX_QUERIES,
  SEARCH_OUTPUT_COLUMNS,
  type SqlValue,
} from "./types.js";

export function isHiddenSearchColumn(name: string, embeddingColumn: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === embeddingColumn.toLowerCase() ||
    lower === "hash" ||
    lower.endsWith("_hash")
  );
}

export function parseSearchColumns(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  let raw: unknown[];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    raw = trimmed.split(",");
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      return null;
    }
    raw = value;
  } else {
    throw new McpError(
      ErrorCode.InvalidParams,
      "columns must be an array of identifiers",
    );
  }
  return raw.map((item) => {
    if (typeof item !== "string") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "columns must be an array of identifiers",
      );
    }
    const name = item.trim();
    quoteIdent(name);
    return name;
  });
}

export function searchPredicate(args: any): string | null {
  return optionalString(args.where);
}

export function parseIncludeScores(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "include_scores must be a boolean",
    );
  }
  return value;
}

export function searchSelectList(
  columns: string[] | null,
  embeddingColumn: string,
  extras: string[],
  qualifier?: string,
): string {
  const prefix = qualifier ? `${qualifier}.` : "";
  const extraSql = extras.join(", ");
  if (!columns) {
    return extraSql ? `${prefix}*, ${extraSql}` : `${prefix}*`;
  }
  const selected = columns.filter((name) => {
    const lower = name.toLowerCase();
    return (
      !isHiddenSearchColumn(name, embeddingColumn) &&
      !SEARCH_OUTPUT_COLUMNS.has(lower)
    );
  });
  if (selected.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "columns must include at least one non-embedding, non-hash column",
    );
  }
  const selectedSql = selected
    .map((name) => `${prefix}${quoteIdent(name)}`)
    .join(", ");
  return extraSql ? `${selectedSql}, ${extraSql}` : selectedSql;
}

function parseId(value: unknown): IdValue {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "id must be a string or finite number",
    );
  }
  return value;
}

export function parseFields(fields: unknown): Record<string, SqlValue> {
  if (fields === undefined || fields === null) {
    return {};
  }
  if (typeof fields !== "object" || Array.isArray(fields)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "fields must be an object of column -> value",
    );
  }
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(
    fields as Record<string, unknown>,
  )) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `fields.${key} must be a string, number, boolean, or null`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `fields.${key} must contain a finite number`,
      );
    }
    out[key] = value as SqlValue;
  }
  return out;
}

export function matchClause(
  args: any,
  idColumn: string,
  paramOffset: number,
): { clause: string; params: SqlValue[] } {
  const where = optionalString(args.where);
  const hasId = args.id !== undefined && args.id !== null;
  if (where && hasId) {
    throw new McpError(ErrorCode.InvalidParams, "Provide id or where, not both");
  }
  if (where) {
    return { clause: `(${where})`, params: [] };
  }
  if (hasId) {
    return {
      clause: `${quoteIdent(idColumn)} = $${paramOffset + 1}`,
      params: [parseId(args.id)],
    };
  }
  throw new McpError(ErrorCode.InvalidParams, "Provide id or where");
}

export function parseLexical(value: unknown, hybrid: boolean): "fts" | "trgm" {
  if (value === undefined || value === null || value === "") {
    return "fts";
  }
  if (typeof value !== "string") {
    throw new McpError(ErrorCode.InvalidParams, "lexical must be fts or trgm");
  }
  const lexical = value.trim().toLowerCase();
  if (!lexical) {
    return "fts";
  }
  if (!hybrid) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "text_column is required when lexical is set",
    );
  }
  if (lexical !== "fts" && lexical !== "trgm") {
    throw new McpError(ErrorCode.InvalidParams, "lexical must be fts or trgm");
  }
  return lexical;
}

export function parseTextColumn(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "text_column must be an identifier",
    );
  }
  const name = value.trim();
  if (!name) {
    return null;
  }
  quoteIdent(name);
  return name;
}

export function parseQueries(value: unknown): string[] {
  if (typeof value === "string") {
    const query = value.trim();
    if (!query) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "query must contain at least one non-empty string",
      );
    }
    return [query];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "query must be a non-empty array of strings",
    );
  }
  if (value.length > MAX_QUERIES) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `query accepts at most ${MAX_QUERIES} strings`,
    );
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `query[${index}] must be a non-empty string`,
      );
    }
    return item.trim();
  });
}

export function parseResponseFormat(args: any): "markdown" | null {
  const value = args?.response_format ?? args?.responseFormat;
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.trim().toLowerCase() !== "markdown") {
    throw new McpError(
      ErrorCode.InvalidParams,
      'response_format must be empty or "markdown"',
    );
  }
  return "markdown";
}
