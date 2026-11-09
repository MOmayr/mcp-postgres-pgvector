import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/** Safely extract a message string from an unknown thrown value. */
export function getErrorMessage(error: unknown): string {
  return formatDbError(error);
}

/**
 * Postgres error text, including the fields the server actually sends
 * (SQLSTATE, position, detail, hint, schema, table, column, constraint)
 * and a pgAdmin-style line with a caret when the query text is available.
 */
export function formatDbError(error: unknown, query?: string): string {
  const message = messageOf(error);
  const fields = pgErrorFields(error);
  if (!fields) {
    return message;
  }

  const lines: string[] = [];
  lines.push(fields.severity ? `${fields.severity}: ${message}` : message);

  const position = fields.position ? Number(fields.position) : NaN;
  if (query && Number.isInteger(position)) {
    const snippet = errorSnippet(query, position);
    if (snippet) {
      lines.push(snippet);
    }
  }

  const labeled: Array<[string, string | undefined]> = [
    ["Detail", fields.detail],
    ["Hint", fields.hint],
    ["Where", fields.where],
    ["Schema", fields.schema],
    ["Table", fields.table],
    ["Column", fields.column],
    ["Data type", fields.dataType],
    ["Constraint", fields.constraint],
    ["Internal position", fields.internalPosition],
    ["Internal query", fields.internalQuery],
  ];
  for (const [label, value] of labeled) {
    if (value) {
      lines.push(`${label}: ${value}`);
    }
  }

  if (fields.code) {
    lines.push(`SQL state: ${fields.code}`);
  }
  if (fields.position) {
    lines.push(`Character: ${fields.position}`);
  }

  return lines.join("\n");
}

export function wrapDbError(prefix: string, error: unknown): never {
  if (error instanceof McpError) {
    throw error;
  }
  throw new McpError(
    ErrorCode.InternalError,
    `${prefix}: ${formatDbError(error)}`,
  );
}

function messageOf(error: unknown): string {
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

type PgErrorFields = {
  severity?: string;
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
  internalPosition?: string;
  internalQuery?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
};

function pgErrorFields(error: unknown): PgErrorFields | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const record = error as Record<string, unknown>;
  const code = asString(record.code);
  const position = asString(record.position);
  const isSqlState = code !== undefined && /^[0-9A-Z]{5}$/.test(code);
  const hasPosition = position !== undefined && /^\d+$/.test(position);
  if (!isSqlState && !hasPosition) {
    return null;
  }
  return {
    severity: asString(record.severity),
    code,
    detail: asString(record.detail),
    hint: asString(record.hint),
    position,
    internalPosition: asString(record.internalPosition),
    internalQuery: asString(record.internalQuery),
    where: asString(record.where),
    schema: asString(record.schema),
    table: asString(record.table),
    column: asString(record.column),
    dataType: asString(record.dataType),
    constraint: asString(record.constraint),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 1-based Postgres character position, shown like psql / pgAdmin. */
function errorSnippet(query: string, position: number): string | null {
  const chars = Array.from(query);
  const index = position - 1;
  if (index < 0 || index > chars.length) {
    return null;
  }

  let lineStart = 0;
  let lineNumber = 1;
  for (let i = 0; i < index; i += 1) {
    if (chars[i] === "\n") {
      lineStart = i + 1;
      lineNumber += 1;
    }
  }
  let lineEnd = chars.length;
  for (let i = index; i < chars.length; i += 1) {
    if (chars[i] === "\n") {
      lineEnd = i;
      break;
    }
  }

  const line = chars.slice(lineStart, lineEnd).join("");
  const column = index - lineStart;
  const prefix = `LINE ${lineNumber}: `;
  const context = 72;
  let shown = line;
  let caretColumn = column;
  if ([...line].length > context) {
    const points = [...line];
    const start = Math.max(0, column - 36);
    const end = Math.min(points.length, start + context);
    const adjustedStart = Math.max(0, end - context);
    const lead = adjustedStart > 0 ? "..." : "";
    const trail = end < points.length ? "..." : "";
    shown = lead + points.slice(adjustedStart, end).join("") + trail;
    caretColumn = column - adjustedStart + lead.length;
  }

  return `${prefix}${shown}\n${" ".repeat(prefix.length + caretColumn)}^`;
}
