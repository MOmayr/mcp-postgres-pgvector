import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type pg from "pg";
import { embedText, toPgVectorLiteral } from "../../embeddings.js";
import { wrapDbError } from "../../util/error.js";
import { optionalString, parseLimit } from "../../util/parse.js";
import { jsonResult } from "../../util/result.js";
import { qualifiedTable, quoteIdent, stripColumns } from "../../util/sql.js";
import { matchClause, parseFields } from "./args.js";
import {
  assertEmbeddingDimensions,
  embedIntoColumn,
  getEmbeddingColumnMeta,
} from "./column.js";
import type { SqlValue } from "./types.js";

export async function handleVectorExecute(client: pg.Client, args: any) {
  const operation = String(args?.operation || "").toLowerCase();
  if (operation === "insert") {
    return await handleVectorInsert(client, args);
  }
  if (operation === "update") {
    return await handleVectorUpdate(client, args);
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    "operation must be insert or update",
  );
}

async function handleVectorInsert(client: pg.Client, args: any) {
  if (!args?.table || !args?.embedding_column || typeof args.text !== "string") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "table, embedding_column, and text are required",
    );
  }

  const schema = args.schema || "public";
  const table = args.table as string;
  const embeddingColumn = args.embedding_column as string;
  const fields = parseFields(args.fields);
  const textColumn = optionalString(args.text_column);

  if (embeddingColumn in fields) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `fields must not include the embedding column "${embeddingColumn}"; pass text instead`,
    );
  }
  if (textColumn === embeddingColumn) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "text_column must not be the embedding column",
    );
  }
  if (textColumn) {
    fields[textColumn] = args.text;
  }

  try {
    const embedded = await embedIntoColumn(
      client,
      schema,
      table,
      embeddingColumn,
      args.text,
    );
    const columns = [...Object.keys(fields), embeddingColumn];
    const values: SqlValue[] = [...Object.values(fields), embedded.vectorLiteral];
    const placeholders = columns.map((col, i) =>
      col === embeddingColumn ? `$${i + 1}::${embedded.typeName}` : `$${i + 1}`,
    );

    const sql = `
      INSERT INTO ${qualifiedTable(schema, table)}
        (${columns.map(quoteIdent).join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING *
    `;

    const result = await client.query(sql, values);
    return jsonResult(stripColumns(result.rows, [embeddingColumn]));
  } catch (error) {
    wrapDbError("vector_insert failed", error);
  }
}

async function handleVectorUpdate(client: pg.Client, args: any) {
  if (!args?.table || !args?.embedding_column) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "table and embedding_column are required",
    );
  }
  if (args.fields !== undefined && args.fields !== null) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "update only writes the embedding column; use execute for other columns",
    );
  }

  const schema = args.schema || "public";
  const table = args.table as string;
  const embeddingColumn = args.embedding_column as string;
  const idColumn = optionalString(args.id_column) || "id";
  const textColumn = optionalString(args.text_column);
  const hasText = typeof args.text === "string";
  if (hasText && textColumn) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Provide text or text_column, not both",
    );
  }
  if (!hasText && !textColumn) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Provide text or text_column",
    );
  }
  if (textColumn === embeddingColumn) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "text_column must not be the embedding column",
    );
  }

  const tableSql = qualifiedTable(schema, table);
  const embedSql = quoteIdent(embeddingColumn);
  const { clause, params } = matchClause(args, idColumn, 0);
  const limit = parseLimit(args.limit, 10);

  try {
    if (hasText) {
      const candidates = await client.query(
        `SELECT ctid FROM ${tableSql} WHERE ${clause} LIMIT 2`,
        params,
      );
      if (candidates.rowCount === 0) {
        throw new McpError(ErrorCode.InvalidParams, "No rows matched id/where");
      }
      if ((candidates.rowCount ?? 0) > 1) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "text + where matched multiple rows; use id, or text_column for per-row embed",
        );
      }

      const embedded = await embedIntoColumn(
        client,
        schema,
        table,
        embeddingColumn,
        args.text,
      );
      const result = await client.query(
        `
        UPDATE ${tableSql}
        SET ${embedSql} = $1::${embedded.typeName}
        WHERE ctid = $2
        RETURNING *
        `,
        [embedded.vectorLiteral, candidates.rows[0].ctid],
      );
      return jsonResult({
        rowCount: result.rowCount,
        rows: stripColumns(result.rows, [embeddingColumn]),
      });
    }

    const textSql = quoteIdent(textColumn!);
    const meta = await getEmbeddingColumnMeta(
      client,
      schema,
      table,
      embeddingColumn,
    );
    const source = await client.query(
      `
      SELECT ctid, ${textSql} AS source_text
      FROM ${tableSql}
      WHERE ${clause}
        AND ${textSql} IS NOT NULL
        AND btrim(${textSql}::text) <> ''
      LIMIT ${limit}
      `,
      params,
    );

    const updated: Record<string, unknown>[] = [];
    for (const row of source.rows) {
      const embedding = await embedText(String(row.source_text));
      assertEmbeddingDimensions(embedding, meta);
      const result = await client.query(
        `
        UPDATE ${tableSql}
        SET ${embedSql} = $1::${meta.typeName}
        WHERE ctid = $2
        RETURNING *
        `,
        [toPgVectorLiteral(embedding), row.ctid],
      );
      updated.push(...stripColumns(result.rows, [embeddingColumn]));
    }

    return jsonResult({ rowCount: updated.length, rows: updated });
  } catch (error) {
    wrapDbError("vector_update failed", error);
  }
}
