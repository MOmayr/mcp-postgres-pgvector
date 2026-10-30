import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export function quoteIdent(name: string): string {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid SQL identifier: ${String(name)}`,
    );
  }
  return `"${name}"`;
}

export function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** Ranking expressions stay full precision. Display scores default to two decimals. */
export function roundedScore(expr: string, digits = 2): string {
  return `round((${expr})::numeric, ${digits})::float8`;
}

export function stripColumns(
  rows: Record<string, unknown>[],
  columns: string[],
): Record<string, unknown>[] {
  if (columns.length === 0) {
    return rows;
  }
  return rows.map((row) => {
    const copy = { ...row };
    for (const column of columns) {
      delete copy[column];
    }
    return copy;
  });
}

// Convert ? parameters without touching quoted strings, comments, or
// PostgreSQL JSON operators such as ?| and ?&.
export function convertToNamedParams(query: string): string {
  let paramIndex = 0;
  let output = "";
  let state:
    | "normal"
    | "single"
    | "double"
    | "lineComment"
    | "blockComment"
    | "dollarQuote" = "normal";
  let blockCommentDepth = 0;
  let dollarQuote = "";

  for (let i = 0; i < query.length; i += 1) {
    const char = query[i];
    const next = query[i + 1];

    if (state === "single") {
      output += char;
      if (char === "\\" && next) {
        output += next;
        i += 1;
      } else if (char === "'" && next === "'") {
        output += next;
        i += 1;
      } else if (char === "'") {
        state = "normal";
      }
      continue;
    }

    if (state === "double") {
      output += char;
      if (char === '"' && next === '"') {
        output += next;
        i += 1;
      } else if (char === '"') {
        state = "normal";
      }
      continue;
    }

    if (state === "lineComment") {
      output += char;
      if (char === "\n") {
        state = "normal";
      }
      continue;
    }

    if (state === "blockComment") {
      if (char === "/" && next === "*") {
        output += "/*";
        i += 1;
        blockCommentDepth += 1;
      } else if (char === "*" && next === "/") {
        output += "*/";
        i += 1;
        blockCommentDepth -= 1;
        if (blockCommentDepth === 0) {
          state = "normal";
        }
      } else {
        output += char;
      }
      continue;
    }

    if (state === "dollarQuote") {
      if (query.startsWith(dollarQuote, i)) {
        output += dollarQuote;
        i += dollarQuote.length - 1;
        dollarQuote = "";
        state = "normal";
      } else {
        output += char;
      }
      continue;
    }

    if (char === "'") {
      output += char;
      state = "single";
    } else if (char === '"') {
      output += char;
      state = "double";
    } else if (char === "-" && next === "-") {
      output += "--";
      i += 1;
      state = "lineComment";
    } else if (char === "/" && next === "*") {
      output += "/*";
      i += 1;
      blockCommentDepth = 1;
      state = "blockComment";
    } else if (char === "$") {
      const tag = query.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        output += tag;
        i += tag.length - 1;
        dollarQuote = tag;
        state = "dollarQuote";
      } else {
        output += char;
      }
    } else if (char === "?" && next !== "|" && next !== "&") {
      const before = query.slice(0, i).trimEnd().at(-1);
      const after = query.slice(i + 1).trimStart()[0];
      const looksLikeJsonOperator =
        after === "'" &&
        before !== undefined &&
        /[\w$)\]"']/.test(before);

      if (looksLikeJsonOperator) {
        output += char;
      } else {
        output += `$${++paramIndex}`;
      }
    } else {
      output += char;
    }
  }

  return output;
}

export function prepareSql(sql: string): string {
  return sql.includes("?") ? convertToNamedParams(sql) : sql;
}
