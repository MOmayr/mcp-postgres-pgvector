import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { PostgresServer, DatabaseConfig } from "./server.js";
import { redactSensitive } from "./util/redact.js";

interface SessionData {
  transport: StreamableHTTPServerTransport;
  pgServer: PostgresServer;
  disposePromise?: Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * HTTP transport for the MCP server using Streamable HTTP (the modern MCP
 * HTTP transport; supersedes the deprecated SSE transport).
 *
 * Endpoints (single endpoint /mcp handles POST, GET, DELETE):
 *   POST   /mcp - Client-to-server JSON-RPC messages (initialize + tool calls)
 *   GET    /mcp - Server-to-client streaming
 *   DELETE /mcp - Session termination
 *   GET    /health - Health check
 *
 * PostgreSQL credentials are accepted via request headers so each session
 * (each connected agent) can target a different database:
 *   X-PG-Host, X-PG-Port, X-PG-User, X-PG-Password, X-PG-Database
 * If headers are absent the server falls back to environment variables
 * (PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE).
 */
export async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(
    cors({
      origin: "*",
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  );

  const sessions: Record<string, SessionData> = {};

  async function disposeSession(
    sessionId: string,
    sessionData: SessionData,
  ): Promise<void> {
    if (!sessionData.disposePromise) {
      sessionData.disposePromise = (async () => {
        try {
          await sessionData.pgServer.dispose();
        } catch {
          /* ignore cleanup failures */
        } finally {
          if (sessions[sessionId] === sessionData) {
            delete sessions[sessionId];
          }
          console.error(
            `[HTTP] Session closed: ${sessionId} (active: ${Object.keys(sessions).length})`,
          );
        }
      })();
    }
    await sessionData.disposePromise;
  }

  // Logging middleware: prints every request and final response
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = randomUUID().slice(0, 8);
    const start = Date.now();

    console.error(`\n[${reqId}] --> ${req.method} ${req.path}`);

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId) {
      console.error(`[${reqId}]     session: ${sessionId}`);
    }

    // Log PG-related headers (mask password) for easy debugging
    const pgHeaderKeys = Object.keys(req.headers).filter((h) =>
      h.startsWith("x-pg-"),
    );
    if (pgHeaderKeys.length > 0) {
      const masked = pgHeaderKeys
        .map((h) => {
          const isSecret = h.includes("password");
          return `${h}=${isSecret ? "***" : req.headers[h]}`;
        })
        .join(", ");
      console.error(`[${reqId}]     pg headers: ${masked}`);
    }

    if (req.body && Object.keys(req.body).length > 0) {
      const bodyStr = JSON.stringify(redactSensitive(req.body), null, 2);
      const truncated =
        bodyStr.length > 800
          ? bodyStr.slice(0, 800) + "...[truncated]"
          : bodyStr;
      console.error(`[${reqId}]     body: ${truncated}`);
    }

    res.on("finish", () => {
      const duration = Date.now() - start;
      console.error(
        `[${reqId}] <-- ${res.statusCode} ${req.method} ${req.path} (${duration}ms)`,
      );
    });

    next();
  });

  // Extract PG credentials from request headers.
  // Expected headers (all lowercase): x-pg-host, x-pg-port, x-pg-user,
  // x-pg-password, x-pg-database.
  function getPgConfigFromHeaders(req: Request): DatabaseConfig | null {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const v = (h: string | string[] | undefined) =>
      Array.isArray(h) ? h[0] : h;

    const host = v(headers["x-pg-host"]);
    const port = v(headers["x-pg-port"]);
    const user = v(headers["x-pg-user"]);
    const password = v(headers["x-pg-password"]);
    const database = v(headers["x-pg-database"]);

    if (!host || !user || !password || !database) {
      return null;
    }

    return {
      host,
      port: port ? parseInt(port, 10) : 5432,
      user,
      password,
      database,
    };
  }

  // POST /mcp - main message endpoint (handles both initialize and tool calls)
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let sessionData: SessionData;

    try {
      if (sessionId && sessions[sessionId]) {
        console.log(`Existing session: ${sessionId}`);
        sessionData = sessions[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session: create a fresh PostgresServer + transport
        const pgConfig = getPgConfigFromHeaders(req);
        const pgServer = new PostgresServer(pgConfig || undefined);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions[sid] = sessionData;
            console.error(
              `[HTTP] Session initialized: ${sid} (active: ${Object.keys(sessions).length})`,
            );
          },
        });

        transport.onclose = async () => {
          const sid = transport.sessionId;
          if (sid) {
            await disposeSession(sid, sessionData);
          }
        };

        sessionData = { transport, pgServer };
        await pgServer.connectTransport(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Invalid or missing session ID. Send an initialize request first.",
          },
          id: req.body?.id ?? null,
        });
        return;
      }

      await sessionData.transport.handleRequest(req, res, req.body);
    } catch (error) {
      const message = errorMessage(error);
      console.error(`[HTTP] Error handling POST /mcp: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: req.body?.id ?? null,
        });
      }
    }
  });

  // GET /mcp - server-to-client streaming (per session)
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const sessionData = sessionId ? sessions[sessionId] : undefined;

    if (!sessionData) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    try {
      await sessionData.transport.handleRequest(req, res);
    } catch (error) {
      const message = errorMessage(error);
      console.error(`[HTTP] Error handling GET /mcp: ${message}`);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  // DELETE /mcp - explicit session termination
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const sessionData = sessionId ? sessions[sessionId] : undefined;

    if (sessionData) {
      try {
        await sessionData.transport.close();
        await disposeSession(sessionId!, sessionData);
      } catch {
        /* ignore */
      }
      console.error(
        `[HTTP] Session terminated: ${sessionId} (active: ${Object.keys(sessions).length})`,
      );
    }
    res.status(200).end();
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      transport: "streamable-http",
      activeSessions: Object.keys(sessions).length,
    });
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`\n============================================`);
    console.error(`PostgreSQL MCP server running on HTTP`);
    console.error(`  Streamable HTTP endpoint:  http://localhost:${port}/mcp`);
    console.error(
      `  Health check:             http://localhost:${port}/health`,
    );
    console.error(`============================================\n`);
  });
}
