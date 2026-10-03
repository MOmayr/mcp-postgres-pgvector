export const VECTOR_TOOL_DEFINITIONS = [
  {
    name: "list_vector_tables",
    description:
      "List tables that have pgvector columns (vector or halfvec), with schema, column, and data type.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "vector_search",
    description:
      "Nearest-neighbor search. Embeds each query string and ranks with pgvector. query is an array: one element runs one search; multiple elements run the same search (same table, where, columns, limit) once per element and return grouped results. Pass text_column to fuse each ranking with a lexical list using reciprocal rank fusion (k=60). lexical=fts (default) uses English full text: stems, drops stop words, keeps Arabic, and drops query terms that appear in more than 40% of rows. lexical=trgm uses pg_trgm word_similarity above pg_trgm.word_similarity_threshold. Omit text_column for dense search only. A where clause sets hnsw.iterative_scan=strict_order for that query. hnsw.ef_search is raised when the candidate limit is above 40. Default payload omits embedding and *hash. include_scores defaults to true and adds distance, plus rrf, dense_rank, and lexical_rank when hybrid. Set include_scores false to omit those columns. response_format=markdown returns one markdown table per query element.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        embedding_column: {
          type: "string",
          description: "vector or halfvec column",
        },
        query: {
          type: "array",
          items: { type: "string" },
          description:
            "Search strings (max 20). One element searches that text. Multiple elements each return their own group, tagged Results for {text}. A single string is accepted as one element.",
        },
        schema: { type: "string", description: "Schema (default: public)" },
        where: {
          type: "string",
          description:
            "SQL WHERE fragment applied before ranking (no WHERE keyword)",
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description:
            "Payload columns. Omit for all except embedding and *hash.",
        },
        limit: {
          type: "number",
          description: "Max rows (default 10, max 100)",
        },
        metric: {
          type: "string",
          description: "cosine (default), l2, or ip. Must match the HNSW opclass to use the index.",
        },
        text_column: {
          type: "string",
          description:
            "Text column for hybrid search. Use the passage column for fts, or the short name column for trgm. Omit for dense search only.",
        },
        lexical: {
          type: "string",
          description:
            "fts (default) or trgm. Requires text_column. fts for passages. trgm for short names that have a trigram index.",
        },
        response_format: {
          type: "string",
          description:
            'Empty for JSON. "markdown" returns one table per query element, headed Results for {text}, using the same columns as the JSON rows.',
        },
        include_scores: {
          type: "boolean",
          description:
            "Default true. When false, omit distance, and omit rrf, dense_rank, and lexical_rank on hybrid search. Ranking is unchanged.",
        },
      },
      required: ["table", "embedding_column", "query"],
    },
  },
  {
    name: "vector_execute",
    description:
      "Insert or update a vector/halfvec column by embedding text. insert: embed `text` (optional fields, optional persist via text_column). update: write only the vector. Source is `text` (single row: id, or where that matches one row) or `text_column` (embed each matched row, where/id, optional limit). Use execute for delete and non-vector columns.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "insert or update",
        },
        table: { type: "string" },
        schema: { type: "string", description: "Default: public" },
        embedding_column: {
          type: "string",
          description: "vector or halfvec column to write",
        },
        text: {
          type: "string",
          description:
            "Literal to embed. Required for insert. For update, exactly one of text or text_column.",
        },
        text_column: {
          type: "string",
          description:
            "insert: also store `text` in this varchar. update: read this column per row and embed it.",
        },
        fields: {
          type: "object",
          description: "insert only: other column values",
        },
        id: { type: ["string", "number"], description: "update: single row" },
        id_column: { type: "string", description: "Default: id" },
        where: {
          type: "string",
          description: "update: SQL WHERE fragment (no WHERE keyword)",
        },
        limit: {
          type: "number",
          description:
            "update + text_column: max rows (default 10, max 100)",
        },
      },
      required: ["operation", "table", "embedding_column"],
    },
  },
];
