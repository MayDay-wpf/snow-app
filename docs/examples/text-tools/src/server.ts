import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import manifest from "../plugin.json";
import { registerTextInspect } from "./tools/textInspect";

const server = new McpServer({ name: manifest.id, version: manifest.version });
registerTextInspect(server);
await server.connect(new StdioServerTransport());
