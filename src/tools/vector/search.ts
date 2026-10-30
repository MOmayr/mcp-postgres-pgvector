import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type pg from "pg";
import { embedTexts, toPgVectorLiteral } from "../../embeddings.js";
import { wrapDbError } from "../../util/error.js";
import { markdownTable } from "../../util/markdown.js";
import { parseLimit } from "../../util/parse.js";
import { jsonResult, textResult } from "../../util/result.js";
import { qualifiedTable, quoteIdent, roundedScore, stripColumns } from "../../util/sql.js";
import {
  isHiddenSearchColumn,
  parseIncludeScores,
  parseLexical,
  parseQueries,
  parseResponseFormat,
  parseSearchColumns,
  parseTextColumn,
  searchPredicate,
  searchSelectList,
} from "./args.js";
import { assertEmbeddingDimensions, getEmbeddingColumnMeta } from "./column.js";
import {
  hybridCandidateLimit,
  hybridScoreSql,
  hybridSearchSql,
} from "./hybrid.js";
import { DISTANCE_OPS, HNSW_EF_MIN } from "./types.js";

function queryResultLabel(query: string): string {
  return `Results for ${query.replace(/\s+/g, " ").trim()}`;
}

function rowsToMarkdown(
  query: string,
  rows: Record<string, unknown>[],
): string {
  return `## ${queryResultLabel(query)}\n\n${markdownTable(rows)}`;
}

function visibleSearchRows(
  rows: Record<string, unknown>[],
  embeddingColumn: string,
): Record<string, unknown>[] {
  const hidden = Object.keys(rows[0] ?? {}).filter((name) =>
    isHiddenSearchColumn(name, embeddingColumn),
  );
  return stripColumns(rows, hidden);
}

async function queryWithHnsw(
  client: pg.Client,
  efSearch: number,
  iterative: boolean,
  sql: string,
  paramSets: string[][],
): Promise<pg.QueryResult[]> {
  const run = async () => {
    const results: pg.QueryResult[] = [];
    for (const params of paramSets) {
      results.push(await client.query(sql, params));
    }
    return results;
  };

  if (!iterative && efSearch <= HNSW_EF_MIN) {
    return run();
  }

  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('hnsw.ef_search', $1, true)", [
      String(efSearch),
    ]);
    if (iterative) {
      await client.query(
        "SELECT set_config('hnsw.iterative_scan', 'strict_order', true)",
      );
    }
    const results = await run();
    await client.query("COMMIT");
    return results;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function handleVectorSearch(client: pg.Client, args: any) {
  if (!args?.table || !args?.embedding_column || !args?.query) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "table, embedding_column, and query are required",
    );
  }

  const schema = args.schema || "public";
  const table = args.table as string;
  const embeddingColumn = args.embedding_column as string;
  const metric = (args.metric as string) || "cosine";
  const op = DISTANCE_OPS[metric];
  if (!op) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "metric must be cosine, l2, or ip",
    );
  }
  const queries = parseQueries(args.query);
  const responseFormat = parseResponseFormat(args);
  const limit = parseLimit(args.limit, 10);
  const columns = parseSearchColumns(args.columns);
  const includeScores = parseIncludeScores(args.include_scores);
  const textColumn = parseTextColumn(args.text_column);
  const lexical = parseLexical(args.lexical, textColumn !== null);
  if (
    textColumn &&
    textColumn.toLowerCase() === embeddingColumn.toLowerCase()
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "text_column must not be the embedding column",
    );
  }

  try {
    const meta = await getEmbeddingColumnMeta(
      client,
      schema,
      table,
      embeddingColumn,
    );
    const embeddings = await embedTexts(queries);
    for (const embedding of embeddings) {
      assertEmbeddingDimensions(embedding, meta);
    }

    const tableSql = qualifiedTable(schema, table);
    const embedSql = quoteIdent(embeddingColumn);
    const predicate = searchPredicate(args);
    const candidates = textColumn ? hybridCandidateLimit(limit) : limit;
    const efSearch = Math.max(HNSW_EF_MIN, candidates);

    let sql: string;
    if (!textColumn) {
      const distanceExpr = `(${embedSql} ${op} $1::${meta.typeName})`;
      const selectSql = searchSelectList(
        columns,
        embeddingColumn,
        includeScores ? [`${roundedScore(distanceExpr, 4)} AS distance`] : [],
      );
      const whereSql = predicate
        ? `WHERE ${embedSql} IS NOT NULL AND (${predicate})`
        : `WHERE ${embedSql} IS NOT NULL`;
      sql = `
        SELECT ${selectSql}
        FROM ${tableSql}
        ${whereSql}
        ORDER BY ${embedSql} ${op} $1::${meta.typeName}
        LIMIT ${limit}
      `;
    } else {
      const textSql = quoteIdent(textColumn);
      const distanceExpr = `(t.${embedSql} ${op} $1::${meta.typeName})`;
      const scoreExpr = hybridScoreSql(op, distanceExpr);
      const selectSql = searchSelectList(
        columns,
        embeddingColumn,
        includeScores
          ? [
              `${roundedScore(distanceExpr, 4)} AS distance`,
              `${roundedScore(scoreExpr, 4)} AS rrf`,
              "f.dense_rank",
              "f.lexical_rank",
            ]
          : [],
        "t",
      );
      sql = hybridSearchSql({
        tableSql,
        embedSql,
        textSql,
        op,
        typeName: meta.typeName,
        predicate,
        lexical,
        candidates,
        limit,
        selectSql,
        scoreSql: scoreExpr,
      });
    }

    const paramSets = embeddings.map((embedding, index) =>
      textColumn
        ? [toPgVectorLiteral(embedding), queries[index]]
        : [toPgVectorLiteral(embedding)],
    );
    const results = await queryWithHnsw(
      client,
      efSearch,
      predicate !== null,
      sql,
      paramSets,
    );
    const groups = results.map((result) =>
      visibleSearchRows(result.rows, embeddingColumn),
    );

    if (responseFormat === "markdown") {
      return textResult(
        queries
          .map((query, index) => rowsToMarkdown(query, groups[index]))
          .join("\n\n"),
      );
    }
    if (queries.length === 1) {
      return jsonResult(groups[0]);
    }
    return jsonResult(
      queries.map((query, index) => ({
        [queryResultLabel(query)]: groups[index],
      })),
    );
  } catch (error) {
    wrapDbError("vector_search failed", error);
  }
}
