import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
const { Client } = pg;
import { getErrorMessage } from "./util/error.js";
import { textResult } from "./util/result.js";
import {
  EXECUTE_TOOL,
  handleExecute,
  handleQuery,
  handleValidateSql,
  QUERY_TOOL,
  VALIDATE_SQL_TOOL,
} from "./tools/query.js";
import {
  DESCRIBE_TABLES_TOOL,
  handleDescribeTables,
  handleListSchemas,
  handleListTables,
  LIST_SCHEMAS_TOOL,
  LIST_TABLES_TOOL,
} from "./tools/schema.js";
import {
  handleResolveMentions,
  RESOLVE_MENTIONS_TOOL,
} from "./tools/mentions.js";
import {
  handleListVectorTables,
  handleVectorExecute,
  handleVectorSearch,
  VECTOR_TOOL_DEFINITIONS,
} from "./tools/vector/index.js";

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const CONNECT_DB_TOOL = {
  name: "connect_db",
  description: "Connect to PostgreSQL database.",
  inputSchema: {
    type: "object",
    properties: {
      host: {
        type: "string",
        description: "Database host",
      },
      port: {
        type: "number",
        description: "Database port (default: 5432)",
      },
      user: {
        type: "string",
        description: "Database user",
      },
      password: {
        type: "string",
        description: "Database password",
      },
      database: {
        type: "string",
        description: "Database name",
      },
    },
    required: ["host", "user", "password", "database"],
  },
};

export class PostgresServer {
  private server: Server;
  private client: pg.Client | null = null;
  private config: DatabaseConfig | null = null;

  constructor(initialConfig?: DatabaseConfig) {
    this.server = new Server(
      {
        name: "postgres-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    if (initialConfig) {
      this.config = initialConfig;
    }

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error("[MCP Error]", error);
  }

  private async cleanup() {
    const client = this.client;
    this.client = null;
    if (client) {
      await client.end().catch((error) => {
        console.error(
          `[MCP] Error closing PostgreSQL connection: ${getErrorMessage(error)}`,
        );
      });
    }
    await this.server.close();
  }

  /** Public disposal method for use by external transports (e.g. HTTP per-session cleanup). */
  async dispose(): Promise<void> {
    await this.cleanup();
  }

  private async ensureConnection() {
    if (!this.config) {
      const envConfig = this.getEnvConfig();

      if (envConfig) {
        this.config = envConfig;
        console.error(
          "[MCP Info] Using database config from environment variables",
        );
      } else {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Database configuration not set. Provide PG_HOST, PG_USER, PG_PASSWORD, PG_DATABASE env vars, call connect_db, or send PG headers in the HTTP initialize request.",
        );
      }
    }

    if (!this.client) {
      const client = new Client(this.config);
      client.on("error", (error) => {
        console.error(
          `[MCP] PostgreSQL connection lost: ${getErrorMessage(error)}`,
        );
        if (this.client === client) {
          this.client = null;
        }
      });
      this.client = client;
      try {
        await client.connect();
      } catch (error) {
        if (this.client === client) {
          this.client = null;
        }
        await client.end().catch(() => undefined);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to connect to database: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  private getEnvConfig(): DatabaseConfig | null {
    const { PG_HOST, PG_USER, PG_PASSWORD, PG_DATABASE, PG_PORT } = process.env;

    if (PG_HOST && PG_USER && PG_PASSWORD && PG_DATABASE) {
      return {
        host: PG_HOST,
        port: PG_PORT ? parseInt(PG_PORT, 10) : 5432,
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE,
      };
    }

    return null;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        CONNECT_DB_TOOL,
        QUERY_TOOL,
        VALIDATE_SQL_TOOL,
        RESOLVE_MENTIONS_TOOL,
        EXECUTE_TOOL,
        LIST_SCHEMAS_TOOL,
        LIST_TABLES_TOOL,
        DESCRIBE_TABLES_TOOL,
        ...VECTOR_TOOL_DEFINITIONS,
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments;
      switch (request.params.name) {
        case "connect_db":
          return await this.handleConnectDb(args);
        case "query":
          await this.ensureConnection();
          return await handleQuery(this.client!, args);
        case "validate_sql":
          await this.ensureConnection();
          return await handleValidateSql(this.client!, args);
        case "resolve_mentions":
          await this.ensureConnection();
          return await handleResolveMentions(this.client!, args);
        case "execute":
          await this.ensureConnection();
          return await handleExecute(this.client!, args);
        case "list_schemas":
          await this.ensureConnection();
          return await handleListSchemas(this.client!);
        case "list_tables":
          await this.ensureConnection();
          return await handleListTables(this.client!, args);
        case "describe_tables":
          await this.ensureConnection();
          return await handleDescribeTables(this.client!, args);
        case "list_vector_tables":
          await this.ensureConnection();
          return await handleListVectorTables(this.client!);
        case "vector_search":
          await this.ensureConnection();
          return await handleVectorSearch(this.client!, args);
        case "vector_execute":
          await this.ensureConnection();
          return await handleVectorExecute(this.client!, args);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`,
          );
      }
    });
  }

  private async handleConnectDb(args: any) {
    if (!args?.host || !args?.user || !args?.password || !args?.database) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Missing required database configuration parameters",
      );
    }

    if (this.client) {
      const client = this.client;
      this.client = null;
      await client.end().catch(() => undefined);
    }

    this.config = {
      host: args.host,
      port: args.port || 5432,
      user: args.user,
      password: args.password,
      database: args.database,
    };

    try {
      await this.ensureConnection();
      return textResult("Successfully connected to PostgreSQL database");
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to connect to database: ${getErrorMessage(error)}`,
      );
    }
  }

  async run() {
    const transportType = this.getTransportType();

    if (transportType === "http") {
      const { runHttp } = await import("./http.js");
      await runHttp();
    } else {
      const handleTermination = async () => {
        try {
          await this.cleanup();
        } catch (error) {
          console.error("Error during cleanup:", error);
          process.exit(1);
        }
        process.exit(0);
      };
      process.on("SIGINT", handleTermination);
      process.stdin.on("close", handleTermination);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("PostgreSQL MCP server running on stdio");
    }
  }

  async connectTransport(
    transport: StdioServerTransport | StreamableHTTPServerTransport,
  ): Promise<void> {
    await this.server.connect(transport);
  }

  private getTransportType(): "stdio" | "http" {
    if (process.env.TRANSPORT === "http") return "http";
    if (process.argv.includes("--http")) return "http";
    return "stdio";
  }
}
