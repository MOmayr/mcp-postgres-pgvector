export type SqlValue = string | number | boolean | null;
export type IdValue = string | number;

export const DISTANCE_OPS: Record<string, string> = {
  cosine: "<=>",
  l2: "<->",
  ip: "<#>",
};

export const HNSW_EF_MIN = 40;
/**
 * Largest cosine-similarity added for a perfect lexical hit.
 * Smaller than typical gaps between a relevant neighbor and a boilerplate match,
 * so a keyword hit can pass a near neighbor without outranking a clearly closer embedding.
 */
export const LEXICAL_BONUS = 0.05;
/** Non-cosine lexical vote. A rank-1 dense hit scores 1/2, so this cannot outvote it alone. */
export const LEXICAL_RANK_WEIGHT = 0.25;
export const CANDIDATE_CAP = 100;
/** Ignore query lexemes that occur in more than this fraction of rows. */
export const LEXICAL_MAX_DF = 0.4;
export const SEARCH_OUTPUT_COLUMNS = new Set([
  "distance",
  "rrf",
  "dense_rank",
  "lexical_rank",
]);
export const MAX_QUERIES = 20;
