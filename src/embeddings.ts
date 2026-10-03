import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getErrorMessage } from "./util/error.js";
import { positiveIntegerEnv } from "./util/parse.js";

interface EmbeddingApiItem {
  embedding?: number[];
  index?: number;
}

interface EmbeddingApiResponse {
  data?: EmbeddingApiItem[];
}

function expectedDimensions(): number | null {
  if (!process.env.EMBEDDING_DIMENSIONS) {
    return null;
  }
  return positiveIntegerEnv("EMBEDDING_DIMENSIONS", 1);
}

function assertDimensions(embedding: number[], expected: number | null): void {
  if (expected !== null && embedding.length !== expected) {
    throw new McpError(
      ErrorCode.InternalError,
      `Embedding length ${embedding.length} does not match EMBEDDING_DIMENSIONS=${expected}`,
    );
  }
}

function assertEmbeddingValues(embedding: number[]): void {
  if (
    embedding.length === 0 ||
    embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new McpError(
      ErrorCode.InternalError,
      "Embedding endpoint returned invalid embedding values",
    );
  }
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error("Embedding endpoint response is too large");
    }
  }

  if (!response.body) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
      throw new Error("Embedding endpoint response is too large");
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Embedding endpoint response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * Call a local OpenAI-compatible embeddings endpoint (vLLM: POST /v1/embeddings).
 * EMBEDDING_DIMENSIONS is used only to validate the response length — it is not
 * sent to the API, so native-size models (e.g. Qwen3-Embedding-4B at 2560) work
 * without Matryoshka flags.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const url = process.env.EMBEDDING_URL;
  const model = process.env.EMBEDDING_MODEL;

  if (!url) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "EMBEDDING_URL is not set. Example: http://localhost:8000/v1/embeddings",
    );
  }
  if (!model) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "EMBEDDING_MODEL is not set. Example: Qwen/Qwen3-Embedding-4B",
    );
  }
  if (texts.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "At least one text is required to embed",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = process.env.EMBEDDING_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const timeoutMs = positiveIntegerEnv("EMBEDDING_TIMEOUT_MS", 30000);
  const maxResponseBytes = positiveIntegerEnv(
    "EMBEDDING_MAX_RESPONSE_BYTES",
    50 * 1024 * 1024,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: texts.length === 1 ? texts[0] : texts,
        encoding_format: "float",
      }),
      signal: controller.signal,
    });
    bodyText = await readResponseBody(response, maxResponseBytes);
  } catch (error) {
    const timedOut = (error as { name?: string })?.name === "AbortError";
    throw new McpError(
      ErrorCode.InternalError,
      timedOut
        ? `Embedding endpoint timed out after ${timeoutMs}ms`
        : `Failed to reach embedding endpoint: ${getErrorMessage(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const snippet =
      bodyText.length > 400 ? bodyText.slice(0, 400) + "..." : bodyText;
    throw new McpError(
      ErrorCode.InternalError,
      `Embedding endpoint returned ${response.status}: ${snippet}`,
    );
  }

  let parsed: EmbeddingApiResponse;
  try {
    parsed = JSON.parse(bodyText) as EmbeddingApiResponse;
  } catch {
    throw new McpError(
      ErrorCode.InternalError,
      "Embedding endpoint returned non-JSON",
    );
  }

  const items = parsed.data;
  if (!Array.isArray(items) || items.length !== texts.length) {
    throw new McpError(
      ErrorCode.InternalError,
      "Embedding endpoint returned an unexpected data payload",
    );
  }

  const hasIndexes = items.some((item) => item.index !== undefined);
  if (hasIndexes) {
    const indexes = items.map((item) => item.index);
    if (
      indexes.some(
        (index) =>
          !Number.isInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= texts.length,
      ) ||
      new Set(indexes).size !== texts.length
    ) {
      throw new McpError(
        ErrorCode.InternalError,
        "Embedding endpoint returned invalid item indexes",
      );
    }
  }

  const ordered = hasIndexes
    ? [...items].sort((a, b) => (a.index as number) - (b.index as number))
    : items;
  const expected = expectedDimensions();

  return ordered.map((item) => {
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new McpError(
        ErrorCode.InternalError,
        "Embedding endpoint returned an empty embedding",
      );
    }
    assertEmbeddingValues(item.embedding);
    assertDimensions(item.embedding, expected);
    return item.embedding;
  });
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}

/** pgvector text form, bound as a query parameter and cast in SQL. */
export function toPgVectorLiteral(embedding: number[]): string {
  assertEmbeddingValues(embedding);
  return `[${embedding.join(",")}]`;
}
