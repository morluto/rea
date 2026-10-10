import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";

/** Injectable MCP boundary used by the provider and conformance tests. */
export interface JebMcpConnection {
  /** Connect lazily and return the advertised tool names. */
  connect(signal?: AbortSignal): Promise<readonly string[]>;
  /** Invoke one JEB MCP tool and decode its single structured result. */
  call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
  close(): Promise<void>;
}

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z
    .array(
      z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
    )
    .default([]),
});

/** Decode a JEB MCP tool result without inventing an empty observation. */
export const decodeJebToolResult = (input: unknown): JsonValue => {
  const result = toolResultSchema.parse(input);
  const blocks = result.content.flatMap((block) =>
    block.type === "text" && block.text !== undefined ? [block.text] : [],
  );
  if (result.structuredContent !== undefined) {
    // isError envelopes carry JEB's {success:false, message} refusal semantics;
    // decode them so the provider can preserve the engine's own reason.
    return jsonValueSchema.parse(result.structuredContent);
  }
  if (blocks.length !== 1)
    throw new AnalysisProtocolError(
      "JEB MCP omitted a single structured or text result; unsupported content cannot establish an empty observation.",
    );
  try {
    return jsonValueSchema.parse(JSON.parse(blocks[0] ?? "null"));
  } catch {
    if (result.isError === true)
      throw new AnalysisProtocolError(
        `JEB MCP tool failed: ${blocks[0] ?? "unexplained engine failure"}`,
      );
    return blocks[0] ?? null;
  }
};

export type JebMcpConnectionFactory = (endpoint: URL) => JebMcpConnection;

/** Serve JEB requests from a running engine client over streamable HTTP. */
export const createStreamableHttpJebMcpConnection: JebMcpConnectionFactory = (
  endpoint,
) => {
  let client: Client | undefined;
  let serverTools: readonly string[] | undefined;
  return {
    async connect(signal) {
      client ??= new Client({ name: "rea-jeb", version: "0.0.0" });
      if (serverTools === undefined) {
        await client.connect(
          new StreamableHTTPClientTransport(endpoint, {
            requestInit: { redirect: "error" },
          }),
          signal === undefined ? {} : { signal },
        );
        const listing = await client.listTools(
          {},
          signal === undefined ? {} : { signal },
        );
        serverTools = listing.tools.map((tool) => tool.name);
      }
      return serverTools;
    },
    async call(name, args, signal) {
      if (serverTools === undefined) await this.connect(signal);
      if (client === undefined)
        throw new AnalysisProtocolError("JEB MCP client failed to connect");
      const result = await client.callTool(
        { name, arguments: args },
        signal === undefined ? {} : { signal },
      );
      return decodeJebToolResult(result);
    },
    async close() {
      const active = client;
      if (active !== undefined) await active.close();
      client = undefined;
      serverTools = undefined;
    },
  };
};
