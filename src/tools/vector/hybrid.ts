import {
  CANDIDATE_CAP,
  HNSW_EF_MIN,
  LEXICAL_BONUS,
  LEXICAL_MAX_DF,
  LEXICAL_RANK_WEIGHT,
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
  scoreSql: string;
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
      SELECT ctid, tableoid,
             ROW_NUMBER() OVER (ORDER BY lex DESC, ctid) AS rnk,
             lex,
             max(lex) OVER () AS max_lex
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
    matched AS (
      SELECT b.ctid, b.tableoid, sum(ln(d.n::float8 / d.df)) AS lex
      FROM base b
      JOIN kept k ON b.tv @@ to_tsquery('simple', quote_literal(k.lexeme))
      JOIN df d ON d.lexeme = k.lexeme AND d.df > 0
      GROUP BY b.ctid, b.tableoid
    ),
    lexical AS (
      SELECT ctid, tableoid,
             ROW_NUMBER() OVER (ORDER BY lex DESC, ctid) AS rnk,
             lex,
             max(lex) OVER () AS max_lex
      FROM (
        SELECT ctid, tableoid, lex
        FROM matched
        ORDER BY lex DESC, ctid
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
        d.rnk::int AS dense_rank,
        l.rnk::int AS lexical_rank,
        l.lex AS lex,
        l.max_lex AS max_lex
      FROM dense d
      FULL OUTER JOIN lexical l
        ON d.ctid = l.ctid AND d.tableoid = l.tableoid
    )
    SELECT ${args.selectSql}
    FROM fused f
    JOIN ${args.tableSql} t ON t.ctid = f.ctid AND t.tableoid = f.tableoid
    ORDER BY ${args.scoreSql} DESC, ${distanceExpr} ASC, t.ctid
    LIMIT ${args.limit}
  `;
}

/**
 * Hybrid sort key. Cosine uses similarity plus a capped lexical bonus so the
 * nearest embedding stays ahead of a weak keyword hit. L2 and inner product
 * use a dense reciprocal rank plus a smaller lexical vote, since those
 * distances are not similarities.
 */
export function hybridScoreSql(op: string, distanceExpr: string): string {
  const lexicalFraction = `CASE
    WHEN f.lex IS NULL OR f.max_lex IS NULL OR f.max_lex <= 0 THEN 0::float8
    ELSE f.lex / f.max_lex
  END`;
  if (op === "<=>") {
    return `((1 - ${distanceExpr}) + ${LEXICAL_BONUS}::float8 * (${lexicalFraction}))`;
  }
  return `(
    COALESCE(1.0 / (1 + f.dense_rank), 0)
    + ${LEXICAL_RANK_WEIGHT}::float8 * (${lexicalFraction})
  )`;
}
