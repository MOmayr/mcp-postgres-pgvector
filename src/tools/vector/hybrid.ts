import {
  CANDIDATE_CAP,
  HNSW_EF_MIN,
  LEXICAL_MAX_DF,
  RRF_K,
} from "./types.js";

export function hybridCandidateLimit(limit: number): number {
  return Math.min(CANDIDATE_CAP, Math.max(limit * 4, HNSW_EF_MIN));
}

function andPredicate(predicate: string | null): string {
  return predicate ? `AND (${predicate})` : "";
}

export function hybridSearchSql(args: {
  tableSql: string;
  embedSql: string;
  textSql: string;
  op: string;
  typeName: "vector" | "halfvec";
  predicate: string | null;
  lexical: "fts" | "trgm";
  candidates: number;
  limit: number;
  selectSql: string;
}): string {
  const filter = andPredicate(args.predicate);
  const distanceExpr = `(t.${args.embedSql} ${args.op} $1::${args.typeName})`;
  const dense = `
    dense AS (
      SELECT ctid, tableoid, distance, ROW_NUMBER() OVER (ORDER BY distance, ctid) AS rnk
      FROM (
        SELECT ctid, tableoid, (${args.embedSql} ${args.op} $1::${args.typeName}) AS distance
        FROM ${args.tableSql}
        WHERE ${args.embedSql} IS NOT NULL
          ${filter}
        ORDER BY ${args.embedSql} ${args.op} $1::${args.typeName}
        LIMIT ${args.candidates}
      ) nearest
    )`;
  const lexical =
    args.lexical === "trgm"
      ? `
    lexical AS (
      SELECT ctid, tableoid, ROW_NUMBER() OVER (ORDER BY lex DESC, ctid) AS rnk
      FROM (
        SELECT ctid, tableoid, word_similarity($2, ${args.textSql}::text) AS lex
        FROM ${args.tableSql}
        WHERE ${args.embedSql} IS NOT NULL
          AND ${args.textSql} IS NOT NULL
          AND btrim(${args.textSql}::text) <> ''
          AND $2 <% ${args.textSql}::text
          ${filter}
        ORDER BY lex DESC, ctid
        LIMIT ${args.candidates}
      ) ranked
    )`
      : `
    query_lex AS (
      SELECT DISTINCT lexeme
      FROM unnest(tsvector_to_array(to_tsvector('english', $2))) AS lexeme
    ),
    base AS (
      SELECT ctid, tableoid, to_tsvector('english', ${args.textSql}::text) AS tv
      FROM ${args.tableSql}
      WHERE ${args.embedSql} IS NOT NULL
        AND ${args.textSql} IS NOT NULL
        AND btrim(${args.textSql}::text) <> ''
        ${filter}
    ),
    df AS (
      SELECT q.lexeme, count(*) AS df, (SELECT count(*) FROM base) AS n
      FROM query_lex q
      JOIN base b ON b.tv @@ to_tsquery('simple', quote_literal(q.lexeme))
      GROUP BY q.lexeme
    ),
    kept AS (
      SELECT lexeme
      FROM df
      WHERE n > 0 AND df::float8 / n <= ${LEXICAL_MAX_DF}
      UNION ALL
      SELECT lexeme
      FROM (
        SELECT lexeme
        FROM df
        WHERE NOT EXISTS (
          SELECT 1
          FROM df d2
          WHERE d2.n > 0 AND d2.df::float8 / d2.n <= ${LEXICAL_MAX_DF}
        )
        ORDER BY df ASC, lexeme
        LIMIT 1
      ) fallback
    ),
    tsq AS (
      SELECT to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS q
      FROM kept
    ),
    lexical AS (
      SELECT ctid, tableoid, ROW_NUMBER() OVER (ORDER BY lex DESC, ctid) AS rnk
      FROM (
        SELECT b.ctid, b.tableoid, ts_rank_cd(b.tv, tsq.q) AS lex
        FROM base b
        CROSS JOIN tsq
        WHERE tsq.q IS NOT NULL
          AND b.tv @@ tsq.q
        ORDER BY lex DESC, b.ctid
        LIMIT ${args.candidates}
      ) ranked
    )`;

  const ctes =
    args.lexical === "trgm" ? `${dense}, ${lexical}` : `${lexical}, ${dense}`;

  return `
    WITH
    ${ctes},
    fused AS (
      SELECT
        COALESCE(d.tableoid, l.tableoid) AS tableoid,
        COALESCE(d.ctid, l.ctid) AS ctid,
        (
          COALESCE(1.0 / (${RRF_K} + d.rnk), 0)
          + COALESCE(1.0 / (${RRF_K} + l.rnk), 0)
        )::float8 AS rrf,
        d.rnk::int AS dense_rank,
        l.rnk::int AS lexical_rank
      FROM dense d
      FULL OUTER JOIN lexical l
        ON d.ctid = l.ctid AND d.tableoid = l.tableoid
    )
    SELECT ${args.selectSql}
    FROM fused f
    JOIN ${args.tableSql} t ON t.ctid = f.ctid AND t.tableoid = f.tableoid
    ORDER BY f.rrf DESC, ${distanceExpr} ASC
    LIMIT ${args.limit}
  `;
}
