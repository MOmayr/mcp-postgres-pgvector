#!/usr/bin/env node
import { config } from "dotenv";
import { PostgresServer } from "./server.js";

config();

const server = new PostgresServer();
server.run().catch(console.error);
