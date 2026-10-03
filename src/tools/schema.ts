import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type pg from "pg";
import { getErrorMessage } from "../util/error.js";
import { jsonResult } from "../util/result.js";

export const LIST_SCHEMAS_TOOL = {
  name: "list_schemas",
  description: "List all schemas in the database",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const LIST_TABLES_TOOL = {
  name: "list_tables",
  description: "List tables in the database",
  inputSchema: {
    type: "object",
    properties: {
      schema: {
        type: "string",
        description: "Schema name (default: public)",
      },
    },
    required: [],
  },
};

export const DESCRIBE_TABLES_TOOL = {
  name: "describe_tables",
  description: "Get table structure for single or multiple tables",
  inputSchema: {
    type: "object",
    properties: {
      tables: {
        type: "string",
        description: "Table name(s) (comma separated list)",
      },
      schema: {
        type: "string",
        description: "Schema name (default: public)",
      },
    },
    required: ["tables"],
  },
};

const DESCRIBE_TABLES_SQL = `
WITH table_inputs AS (
  SELECT trim(unnest(string_to_array($2, ','))) AS target_table
),
schema_executions AS (
  SELECT
    t.target_table,
    (
      SELECT
        'column_name | data_type | is_nullable | column_default | is_primary_key | max_len' || CHR(10) ||
        string_agg(
          concat_ws(' | ',
            column_name,
            data_type,
            is_nullable,
            COALESCE(column_default, ''),
            is_primary_key,
            COALESCE(character_maximum_length::text, '')
          ),
          CHR(10)
        )
      FROM (
        SELECT
          c.column_name,
          CASE
            WHEN gc.f_geometry_column IS NOT NULL THEN 'geometry(' || gc.type || ', ' || gc.srid || ')'
            WHEN geog.f_geography_column IS NOT NULL THEN 'geography(' || geog.type || ', ' || geog.srid || ')'
            WHEN c.udt_name IN ('vector', 'halfvec') THEN (
              SELECT format_type(a.atttypid, a.atttypmod)
              FROM pg_catalog.pg_attribute a
              JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid
              JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace
              WHERE ns.nspname = c.table_schema
                AND cl.relname = c.table_name
                AND a.attname = c.column_name
                AND NOT a.attisdropped
              LIMIT 1
            )
            ELSE c.data_type
          END AS data_type,
          c.is_nullable,
          c.column_default,
          CASE
            WHEN pk.constraint_type = 'PRIMARY KEY' THEN 'YES'
            ELSE 'NO'
          END AS is_primary_key,
          c.character_maximum_length
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT
            tc.constraint_type,
            kcu.column_name,
            kcu.table_name,
            kcu.table_schema
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
        ) pk
          ON c.column_name = pk.column_name
          AND c.table_name = pk.table_name
          AND c.table_schema = pk.table_schema
        LEFT JOIN geometry_columns gc
          ON c.table_schema = gc.f_table_schema
          AND c.table_name = gc.f_table_name
          AND c.column_name = gc.f_geometry_column
        LEFT JOIN geography_columns geog
          ON c.table_schema = geog.f_table_schema
          AND c.table_name = geog.f_table_name
          AND c.column_name = geog.f_geography_column
        WHERE c.table_schema = $1
          AND c.table_name = t.target_table
        ORDER BY c.ordinal_position
      ) column_data
    ) AS schema_context
  FROM table_inputs t
)
SELECT jsonb_object_agg(target_table, schema_context) AS tables_schema_payload
FROM schema_executions
`;

export async function handleListSchemas(client: pg.Client) {
  try {
    const result = await client.query(`
      SELECT schema_name
      FROM information_schema.schemata
      ORDER BY schema_name
    `);
    return jsonResult(result.rows, 2);
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list schemas: ${getErrorMessage(error)}`,
    );
  }
}

export async function handleListTables(client: pg.Client, args: any = {}) {
  const schema = args.schema || "public";

  try {
    const result = await client.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
      ORDER BY table_name
    `,
      [schema],
    );
    return jsonResult(result.rows, 2);
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list tables: ${getErrorMessage(error)}`,
    );
  }
}

export async function handleDescribeTables(client: pg.Client, args: any) {
  if (!args?.tables) {
    throw new McpError(ErrorCode.InvalidParams, "Table name is required");
  }

  try {
    const result = await client.query(DESCRIBE_TABLES_SQL, [
      args.schema || "public",
      args.tables,
    ]);
    return jsonResult(result.rows);
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to describe tables: ${getErrorMessage(error)}`,
    );
  }
}
