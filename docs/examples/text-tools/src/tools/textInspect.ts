import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerTextInspect(server: McpServer): void {
  server.registerTool(
    "text_inspect",
    {
      title: "Inspect text",
      description:
        "Count Unicode code points and lines in supplied text. No network, filesystem access or writes.",
      inputSchema: {
        text: z
          .string()
          .max(10000)
          .describe("Text to inspect, up to 10000 UTF-16 code units"),
      },
      outputSchema: {
        codePoints: z.number().int().nonnegative(),
        lines: z.number().int().nonnegative(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ text }) => {
      const result = {
        codePoints: Array.from(text).length,
        lines: text === "" ? 0 : text.split(/\r\n|\r|\n/).length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
