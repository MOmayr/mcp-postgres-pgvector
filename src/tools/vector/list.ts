import type pg from "pg";
import { wrapDbError } from "../../util/error.js";
import { jsonResult } from "../../util/result.js";

export async function handleListVectorTables(client: pg.Client) {
  try {
    const result = await client.query(
      `
      SELECT
        n.nspname AS schema,
        c.relname AS table,
        a.attname AS column,
        t.typname AS type,
        format_type(a.atttypid, a.atttypmod) AS data_type
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_type t ON a.atttypid = t.oid
      WHERE a.attnum > 0
        AND NOT a.attisdropped
        AND c.relkind IN ('r', 'p')
        AND t.typname IN ('vector', 'halfvec')
      ORDER BY 1, 2, 3
      `,
    );
    return jsonResult(result.rows);
  } catch (error) {
    wrapDbError("Failed to list vector tables", error);
  }
}
