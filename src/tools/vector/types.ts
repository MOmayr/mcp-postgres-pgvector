export type SqlValue = string | number | boolean | null;
export type IdValue = string | number;

export const DISTANCE_OPS: Record<string, string> = {
  cosine: "<=>",
  l2: "<->",
  ip: "<#>",
};

export const RRF_K = 60;
export const HNSW_EF_MIN = 40;
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
