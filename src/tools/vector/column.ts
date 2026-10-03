import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type pg from "pg";
import { embedText, toPgVectorLiteral } from "../../embeddings.js";

export async function getEmbeddingColumnMeta(
  client: pg.Client,
  schema: string,
  table: string,
  embeddingColumn: string,
): Promise<{
  typeName: "vector" | "halfvec";
  dataType: string;
  dimensions: number | null;
}> {
  const result = await client.query<{
    typname: string;
    data_type: string;
  }>(
    `
    SELECT t.typname, format_type(a.atttypid, a.atttypmod) AS data_type
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_type t ON a.atttypid = t.oid
    WHERE n.nspname = $1
      AND c.relname = $2
      AND a.attname = $3
      AND a.attnum > 0
      AND NOT a.attisdropped
    `,
    [schema, table, embeddingColumn],
  );
  const row = result.rows[0];
  if (!row) {
    const db = await client.query<{ db: string }>(
      "SELECT current_database() AS db",
    );
    throw new McpError(
      ErrorCode.InvalidParams,
      `Column ${schema}.${table}.${embeddingColumn} was not found in database ${db.rows[0]?.db ?? "unknown"}`,
    );
  }
  if (row.typname !== "vector" && row.typname !== "halfvec") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Column ${schema}.${table}.${embeddingColumn} is ${row.data_type}, not vector/halfvec`,
    );
  }
  const dimensionMatch = row.data_type.match(/\((\d+)\)$/);
  return {
    typeName: row.typname,
    dataType: row.data_type,
    dimensions: dimensionMatch ? Number(dimensionMatch[1]) : null,
  };
}

export function assertEmbeddingDimensions(
  embedding: number[],
  meta: { dataType: string; dimensions: number | null },
): void {
  if (meta.dimensions !== null && embedding.length !== meta.dimensions) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Embedding length ${embedding.length} does not match ${meta.dataType}`,
    );
  }
}

export async function embedIntoColumn(
  client: pg.Client,
  schema: string,
  table: string,
  embeddingColumn: string,
  text: string,
): Promise<{ typeName: "vector" | "halfvec"; vectorLiteral: string }> {
  const meta = await getEmbeddingColumnMeta(
    client,
    schema,
    table,
    embeddingColumn,
  );
  const embedding = await embedText(text);
  assertEmbeddingDimensions(embedding, meta);
  return {
    typeName: meta.typeName,
    vectorLiteral: toPgVectorLiteral(embedding),
  };
}
