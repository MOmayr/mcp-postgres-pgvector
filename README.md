# MCP PostgreSQL Server

MCP server that gives an agent a PostgreSQL connection and a fixed set of tools. The server holds the connection, runs the SQL, and returns rows. The agent does not open `pg` itself.

The primary purpose is normal database work: connect, inspect the schema, run reads, check SQL, and run writes. Search and embedding tools are a second layer. They run when the database has [pgvector](https://github.com/pgvector/pgvector).

## What it does

**PostgreSQL.** `connect_db` opens the connection. `list_schemas`, `list_tables`, and `describe_tables` show the agent what it can query. `describe_tables` includes primary keys, defaults, PostGIS `geometry(type, srid)` and `geography(type, srid)`, and `vector` / `halfvec` types when those catalogs exist. `query` runs `SELECT`, `WITH`, and `EXPLAIN`. `execute` runs `INSERT`, `UPDATE`, and `DELETE`. `validate_sql` runs `EXPLAIN` and returns `true` or the error. `resolve_mentions` ranks name matches with `pg_trgm` (`similarity` or `word_similarity`). Parameters use `$1` or `?`.

**pgvector.** `list_vector_tables` finds `vector` and `halfvec` columns. `vector_search` sends the query text to an OpenAI-compatible `/v1/embeddings` endpoint (vLLM, Ollama, or a hosted API), then ranks rows in PostgreSQL with cosine, L2, or inner product. Pass `text_column` to fuse that ranking with English full text or trigrams (reciprocal rank fusion, `k = 60`). `vector_execute` embeds text and inserts or updates the vector column. The agent passes text. The server fetches the embedding, checks its length against the column, and binds it as a query parameter.

PostgreSQL tools need only a database connection. `list_vector_tables` needs the `vector` extension. `vector_search` and `vector_execute` also need `EMBEDDING_URL` and `EMBEDDING_MODEL`.

## Why this shape

- `query` accepts only `SELECT`, `WITH`, and `EXPLAIN`. `execute` accepts only `INSERT`, `UPDATE`, and `DELETE`. A read-only database role still blocks writes if `execute` is called.
- Schema output includes GIS and vector types, so the agent can write SQL that matches the column.
- Vector tools take text. The agent does not build or paste embedding arrays.
- One search call accepts up to 20 strings and can return JSON or one markdown table per string.
- stdio serves a local MCP client. Streamable HTTP serves a remote client, and each session can name its own database in `X-PG-*` headers. Embedding settings stay process-wide.

## Requirements

- Node.js 20 or newer
- PostgreSQL, for every tool
- `pg_trgm`, for `resolve_mentions` and for hybrid search with `lexical: "trgm"`
- `vector` extension for `list_vector_tables`
- `vector` extension, plus `EMBEDDING_URL` and `EMBEDDING_MODEL`, for `vector_search` and `vector_execute`

pgvector HNSW indexes on `vector` support at most 2000 dimensions. For a 2560-dimension model such as Qwen3-Embedding-4B, store the column as `halfvec(2560)`.

## Install

From a clone:

```bash
npm install
npm run build
```

Or, once published:

```bash
npx -y mcp-postgres-server
```

## Configuration

Database credentials and embedding settings are not interchangeable. Put each group in the file below and leave it out of the other.

| What | Where | Variables |
|---|---|---|
| Database, stdio | MCP client `env`, or `config-stdio.json` for the Inspector | `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` |
| Database, HTTP | `X-PG-*` headers on initialize, or the same `PG_*` variables in the process environment | `X-PG-Host`, `X-PG-Port`, `X-PG-User`, `X-PG-Password`, `X-PG-Database` |
| Embeddings | `.env` in this repo | `EMBEDDING_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_API_KEY` |

On startup the server loads `.env` and fills only variables the process does not already have. The stdio client starts the process with `PG_*` already set, so those values stay. `.env` then supplies the embedding endpoint. Several stdio entries can point at different databases and still share one `.env`.

`connect_db` can replace the database connection after startup. It does not read `.env`, and it does not change the embedding endpoint.

`EMBEDDING_TIMEOUT_MS` (default `30000`), `EMBEDDING_MAX_RESPONSE_BYTES` (default `52428800`), `PORT` (default `3000`), and `TRANSPORT` (`http` or stdio) have defaults. They are not in the example files. Set them in the process environment only when you need a different value.

### Local files and git

Committed files use placeholders. Copy them and put real hosts, passwords, and URLs only in the gitignored copies.

| Commit this | Keep local (gitignored) | What to put in it |
|---|---|---|
| `.env.example` | `.env` | Embedding endpoint only |
| `config-stdio.example.json` | `config-stdio.json` | Database credentials for `npm run inspector` |
| `config.example.json` | `config.json` | HTTP Inspector client: URL plus `X-PG-*` headers |

`grants.sql` is site-specific and gitignored. It is not part of the server.

```bash
cp .env.example .env
cp config-stdio.example.json config-stdio.json
cp config.example.json config.json
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
Copy-Item config-stdio.example.json config-stdio.json
Copy-Item config.example.json config.json
```

Edit the copies. Do not put hosts, passwords, API keys, or internal URLs in the example files.

### Environment

| Variable | Set in | Required | Purpose |
|---|---|---|---|
| `PG_HOST` | stdio `env`, or `X-PG-Host` | yes, unless `connect_db` supplies it | Database host |
| `PG_PORT` | stdio `env`, or `X-PG-Port` | no | Default `5432` |
| `PG_USER` | stdio `env`, or `X-PG-User` | yes, same as host | Database user |
| `PG_PASSWORD` | stdio `env`, or `X-PG-Password` | yes, same as host | Database password |
| `PG_DATABASE` | stdio `env`, or `X-PG-Database` | yes, same as host | Database name |
| `EMBEDDING_URL` | `.env` | vector tools only | OpenAI-compatible endpoint, for example `http://localhost:8000/v1/embeddings` |
| `EMBEDDING_MODEL` | `.env` | vector tools only | Model name sent to that endpoint |
| `EMBEDDING_DIMENSIONS` | `.env` | no | Reject a response whose length does not match. Not sent to the API |
| `EMBEDDING_API_KEY` | `.env` | no | Sent as `Authorization: Bearer` |
| `EMBEDDING_TIMEOUT_MS` | process env | no | Default `30000` |
| `EMBEDDING_MAX_RESPONSE_BYTES` | process env | no | Default `52428800` |
| `PORT` | process env | no | HTTP listen port. Default `3000` |
| `TRANSPORT` | process env | no | `http` selects the HTTP transport. Default is stdio |

### stdio

Default transport. Put only `PG_*` in the client `env`. Leave `EMBEDDING_*` in `.env`.

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["build/index.js"],
      "env": {
        "PG_HOST": "localhost",
        "PG_PORT": "5432",
        "PG_USER": "postgres",
        "PG_PASSWORD": "postgres",
        "PG_DATABASE": "postgres"
      }
    }
  }
}
```

Use the absolute path to `build/index.js` when the client does not start in this directory.

### Streamable HTTP

```bash
npm start
```

That builds and runs `node build/index.js --http`. `TRANSPORT=http` does the same.

| Method | Path | Role |
|---|---|---|
| `POST` | `/mcp` | Initialize and tool calls |
| `GET` | `/mcp` | Server-to-client stream |
| `DELETE` | `/mcp` | End the session |
| `GET` | `/health` | `{ "status": "ok", ... }` |

Send database credentials on the initialize request. Later calls in that session reuse them. If the headers are absent, the server uses `PG_*` from the process environment. Embedding settings still come from `.env`. `config.example.json` is an Inspector client config for this transport: it has the server URL and the `X-PG-*` headers, not the embedding variables.

### Inspector

```bash
npm run inspector
```

That reads `config-stdio.json`. Copy it from `config-stdio.example.json` first.

## Tools

### PostgreSQL

These run against the connected database. pgvector is not required.

| Tool | What it does |
|---|---|
| `connect_db` | Connect with `host`, `user`, `password`, `database`, and optional `port`. Replaces the current connection. |
| `query` | Run `SELECT`, `WITH`, or `EXPLAIN`. Optional `params`. |
| `validate_sql` | Run `EXPLAIN` on `sql`. Returns the string `true`, or the error message. |
| `execute` | Run `INSERT`, `UPDATE`, or `DELETE`. Returns `rowCount` and `command`. |
| `list_schemas` | List schema names. |
| `list_tables` | List tables. Optional `schema` (default `public`). |
| `describe_tables` | Structure for a comma-separated `tables` list. Optional `schema`. Includes PostGIS `geometry(type, srid)` and `geography(type, srid)` when those catalogs exist. |
| `resolve_mentions` | Trigram search. `mentions` is one or more strings (max 20). Results are candidates, not confirmed matches. |

### pgvector

These need the `vector` extension and `EMBEDDING_URL` plus `EMBEDDING_MODEL` in `.env`. `list_vector_tables` only needs the extension.

| Tool | What it does |
|---|---|
| `list_vector_tables` | Tables that have a `vector` or `halfvec` column. |
| `vector_search` | Embed each string in `query` and rank with pgvector. Optional hybrid search fuses that ranking with full text or trigrams (reciprocal rank fusion, `k = 60`). |
| `vector_execute` | Embed text and `insert` or `update` the vector column. |

### SQL

```json
{
  "sql": "SELECT id, name FROM places WHERE id = $1",
  "params": [1]
}
```

`execute` uses the same `sql` and `params` shape. Use `query` for `SELECT`.

### Mentions

```json
{
  "table": "places",
  "text_column": "name",
  "mentions": ["harbour", "old town"],
  "operator": "trgm",
  "limit": 5,
  "response_format": "markdown"
}
```

`operator` is `trgm` (default) or `word`. `where` is a SQL fragment without the `WHERE` keyword. `include_scores` defaults to true.

### Vector search

One string returns rows. Several strings run the same search once per string and return a group per string.

```json
{
  "table": "documents",
  "embedding_column": "embedding",
  "query": ["permits near the river"],
  "where": "status = 'active'",
  "columns": ["id", "content"],
  "limit": 10
}
```

Hybrid search: set `text_column`. `lexical` is `fts` (default) or `trgm`.

- `fts` uses English full text. It stems, drops stop words, keeps Arabic, and drops query terms that appear in more than 40% of rows. Use it on a passage column.
- `trgm` uses `word_similarity()` above `pg_trgm.word_similarity_threshold`. Use it on a short name column that has a trigram index.

```json
{
  "schema": "catalog",
  "table": "documents",
  "embedding_column": "embedding",
  "text_column": "body",
  "lexical": "fts",
  "query": ["archaeological sites", "district boundaries"],
  "response_format": "markdown",
  "limit": 10
}
```

`metric` is `cosine` (default), `l2`, or `ip`. It must match the HNSW operator class for the index to be used. A `where` clause sets `hnsw.iterative_scan=strict_order` for that query. The default payload omits the embedding column and columns named `hash` or ending in `_hash`. `include_scores` defaults to true and adds `distance`, plus `rrf`, `dense_rank`, and `lexical_rank` on hybrid search.

### Vector write

`vector_execute` writes the vector column only. Delete rows, or change other columns, with `execute`.

Insert embeds `text`. `text_column` also stores that text. `fields` sets other columns.

```json
{
  "operation": "insert",
  "table": "documents",
  "embedding_column": "embedding",
  "text": "River permit application",
  "text_column": "content",
  "fields": { "status": "active" }
}
```

Update with `text` must match one row (`id`, or a `where` that returns a single row). Update with `text_column` embeds that varchar on each matched row. `id_column` defaults to `id`. `limit` defaults to 10 and caps at 100.

```json
{
  "operation": "update",
  "schema": "catalog",
  "table": "documents",
  "embedding_column": "embedding",
  "text_column": "body",
  "where": "body IS NOT NULL AND embedding IS NULL",
  "limit": 10
}
```

## Development

```bash
npm install
npm run watch
npm run inspector
npm run start:http
```

`npm start` builds, then starts the HTTP transport.

## Security

Queries use parameters. Identifiers passed to the vector and mention tools are restricted to simple names. `where` is a SQL fragment, so give the database role only the rights the agent should have. Prefer a read-only role when the agent does not need to write.

Do not commit `.env`, `config.json`, or `config-stdio.json`.

## License

[MIT](LICENSE)
