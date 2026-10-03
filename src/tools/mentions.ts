import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type pg from "pg";
import { wrapDbError } from "../util/error.js";
import { markdownTable } from "../util/markdown.js";
import { parseLimit } from "../util/parse.js";
import { jsonResult, textResult } from "../util/result.js";
import { qualifiedTable, quoteIdent, roundedScore } from "../util/sql.js";
import {
  parseIncludeScores,
  parseQueries,
  parseResponseFormat,
  parseSearchColumns,
  searchPredicate,
} from "./vector/args.js";

type ColumnMeta = {
  name: string;
  typeName: string;
  category: string;
};

const VECTOR_TYPES = new Set(["vector", "halfvec"]);

type SearchOperator = "trgm" | "word";

export const RESOLVE_MENTIONS_TOOL = {
  name: "resolve_mentions",
  description:
    "Trigram search. Resolve mentioned entities to database matches. Returned rows are candidates, not confirmed matches.",
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      text_column: {
        type: "string",
        description: "Text column to match. A trigram index on this column is optional.",
      },
      mentions: {
        type: "array",
        items: { type: "string" },
        description:
          "Search strings (max 20). A single string is accepted as one element.",
      },
      schema: { type: "string", description: "Schema (default: public)" },
      where: {
        type: "string",
        description: "SQL WHERE fragment applied with the trigram predicate (no WHERE keyword)",
      },
      columns: {
        type: "array",
        items: { type: "string" },
        description:
          "Payload columns. Omit for all. score is added unless include_scores is false.",
      },
      limit: {
        type: "number",
        description: "Max rows per query string (default 5, max 100)",
      },
      operator: {
        type: "string",
        description:
          "operator=trgm (default) uses % and similarity(). operator=word uses %> and word_similarity().",
      },
      include_scores: {
        type: "boolean",
        description:
          "Default true. When false, omit the score column. Ranking is unchanged.",
      },
      response_format: {
        type: "string",
        description:
          'Empty for JSON. "markdown" returns one table per query string, headed Results for {text}.',
      },
    },
    required: ["table", "text_column", "mentions"],
  },
};

function parseOperator(value: unknown): SearchOperator {
  if (value === undefined || value === null || value === "") {
    return "trgm";
  }
  if (typeof value !== "string") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "operator must be trgm or word",
    );
  }
  const operator = value.trim().toLowerCase();
  if (operator === "trgm" || operator === "word") {
    return operator;
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    "operator must be trgm or word",
  );
}

function queryResultLabel(query: string): string {
  return `Results for ${query.replace(/\s+/g, " ").trim()}`;
}

async function loadColumns(
  client: pg.Client,
  schema: string,
  table: string,
): Promise<ColumnMeta[]> {
  const result = await client.query<{
    attname: string;
    typname: string;
    typcategory: string;
  }>(
    `
    SELECT a.attname, t.typname, t.typcategory
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_type t ON a.atttypid = t.oid
    WHERE n.nspname = $1
      AND c.relname = $2
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
    `,
    [schema, table],
  );
  if (result.rows.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Table ${schema}.${table} was not found`,
    );
  }
  return result.rows.map((row) => ({
    name: row.attname,
    typeName: row.typname,
    category: row.typcategory,
  }));
}

function selectList(
  requested: string[] | null,
  available: ColumnMeta[],
  scoreSql: string | null,
): string {
  const names = requested
    ? requested.filter((name) => name.toLowerCase() !== "score")
    : available
        .filter((column) => !VECTOR_TYPES.has(column.typeName))
        .map((column) => column.name);
  if (names.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "columns must include at least one non-vector column",
    );
  }
  const selectedSql = names.map(quoteIdent).join(", ");
  return scoreSql ? `${selectedSql}, ${scoreSql}` : selectedSql;
}

async function queryMentions(
  client: pg.Client,
  sql: string,
  paramSets: string[][],
): Promise<pg.QueryResult[]> {
  const results: pg.QueryResult[] = [];
  for (const params of paramSets) {
    results.push(await client.query(sql, params));
  }
  return results;
}

export async function handleResolveMentions(client: pg.Client, args: any) {
  if (!args?.table || !args?.text_column || !args?.mentions) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "table, text_column, and mentions are required",
    );
  }

  const schema = args.schema || "public";
  const table = args.table as string;
  const textColumn = args.text_column as string;
  quoteIdent(schema);
  quoteIdent(table);
  quoteIdent(textColumn);
  const queries = parseQueries(args.mentions);
  const responseFormat = parseResponseFormat(args);
  const columns = parseSearchColumns(args.columns);
  const predicate = searchPredicate(args);
  const operator = parseOperator(args.operator);
  const includeScores = parseIncludeScores(args.include_scores);
  const limit = parseLimit(args.limit, 5);

  try {
    const available = await loadColumns(client, schema, table);
    const textMeta = available.find((column) => column.name === textColumn)
      ?? available.find(
        (column) => column.name.toLowerCase() === textColumn.toLowerCase(),
      );
    if (!textMeta) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Column ${schema}.${table}.${textColumn} was not found`,
      );
    }
    if (textMeta.category !== "S") {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Column ${schema}.${table}.${textColumn} is ${textMeta.typeName}, not a text type`,
      );
    }

    const textSql = quoteIdent(textMeta.name);
    const scoreSql =
      operator === "word"
        ? `word_similarity($1, ${textSql})`
        : `similarity(${textSql}, $1)`;
    const matchSql =
      operator === "word" ? `${textSql} %> $1` : `${textSql} % $1`;
    const whereSql = predicate ? `AND (${predicate})` : "";
    const sql = `
      SELECT ${selectList(
        columns,
        available,
        includeScores ? `${roundedScore(scoreSql)} AS score` : null,
      )}
      FROM ${qualifiedTable(schema, table)}
      WHERE ${textSql} IS NOT NULL
        AND btrim(${textSql}::text) <> ''
        AND ${matchSql}
        ${whereSql}
      ORDER BY ${scoreSql} DESC
      LIMIT ${limit}
    `;
    const results = await queryMentions(
      client,
      sql,
      queries.map((query) => [query]),
    );
    const groups = results.map(
      (result) => result.rows as Record<string, unknown>[],
    );

    if (responseFormat === "markdown") {
      return textResult(
        queries
          .map(
            (query, index) =>
              `## ${queryResultLabel(query)}\n\n${markdownTable(groups[index])}`,
          )
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
    wrapDbError("resolve_mentions failed", error);
  }
}
