import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type pg from "pg";
import { getErrorMessage } from "../util/error.js";
import { jsonResult, textResult } from "../util/result.js";
import { prepareSql } from "../util/sql.js";

export const QUERY_TOOL = {
  name: "query",
  description: "Execute a SELECT query",
  inputSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SQL SELECT query (use $1, $2, etc. for parameters)",
      },
      params: {
        type: "array",
        items: {
          type: ["string", "number", "boolean", "null"],
        },
        description: "Query parameters (optional)",
      },
    },
    required: ["sql"],
  },
};

export const VALIDATE_SQL_TOOL = {
  name: "validate_sql",
  description:
    "Validate SQL. Returns the string 'true' if the SQL is valid, or an error message string if invalid.",
  inputSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SQL query to validate",
      },
    },
    required: ["sql"],
  },
};

export const EXECUTE_TOOL = {
  name: "execute",
  description: "Execute an INSERT, UPDATE, or DELETE query",
  inputSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description:
          "SQL query (INSERT, UPDATE, DELETE) (use $1, $2, etc. for parameters)",
      },
      params: {
        type: "array",
        items: {
          type: ["string", "number", "boolean", "null"],
        },
        description: "Query parameters (optional)",
      },
    },
    required: ["sql"],
  },
};

export async function handleQuery(client: pg.Client, args: any) {
  if (!args?.sql) {
    throw new McpError(ErrorCode.InvalidParams, "SQL query is required");
  }

  const upperSql = args.sql.trim().toUpperCase();
  if (
    !upperSql.startsWith("SELECT") &&
    !upperSql.startsWith("WITH") &&
    !upperSql.startsWith("EXPLAIN")
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Only SELECT, WITH, or EXPLAIN queries are allowed with query tool",
    );
  }

  try {
    const result = await client.query(prepareSql(args.sql), args.params || []);
    return jsonResult(result.rows);
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Query execution failed: ${getErrorMessage(error)}`,
    );
  }
}

export async function handleValidateSql(client: pg.Client, args: any) {
  if (!args?.sql) {
    throw new McpError(ErrorCode.InvalidParams, "SQL query is required");
  }

  try {
    await handleQuery(client, { sql: `EXPLAIN ${args.sql}` });
    return textResult("true");
  } catch (error) {
    return textResult(getErrorMessage(error));
  }
}

export async function handleExecute(client: pg.Client, args: any) {
  if (!args?.sql) {
    throw new McpError(ErrorCode.InvalidParams, "SQL query is required");
  }

  if (args.sql.trim().toUpperCase().startsWith("SELECT")) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Use query tool for SELECT statements",
    );
  }

  try {
    const result = await client.query(prepareSql(args.sql), args.params || []);
    return jsonResult({
      rowCount: result.rowCount,
      command: result.command,
    });
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Query execution failed: ${getErrorMessage(error)}`,
    );
  }
}
