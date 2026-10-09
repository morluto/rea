import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import type { IdaConfiguration } from "./IdaConfiguration.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";

/** Injectable MCP boundary used by the provider and transport conformance tests. */
export interface IdaMcpConnection {
  connect(): Promise<readonly string[]>;
  call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue>;
  serverInfo(): JsonValue;
  close(): Promise<void>;
}

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(
    z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
  ),
  _meta: z
    .object({
      ida_mcp: z
        .object({
          output_truncated: z.boolean().optional(),
          download_hint: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

/** Decode Python FastMCP's scalar wrapper without dropping structured dictionaries. */
export const decodeIdaToolResult = (input: unknown): JsonValue => {
  const result = toolResultSchema.parse(input);
  const blocks = result.content.flatMap((block) =>
    block.type === "text" && block.text !== undefined ? [block.text] : [],
  );
  if (result.isError === true)
    throw new AnalysisProtocolError(
      `IDA MCP tool failed: ${blocks.join("\n")}`,
    );
  if (result._meta?.ida_mcp?.output_truncated === true)
    throw new AnalysisProtocolError(
      `IDA MCP truncated its output; the preview cannot establish a complete observation. ${result._meta.ida_mcp.download_hint ?? "Use the upstream output download workflow to retrieve the full result."}`,
    );
  if (result.structuredContent !== undefined) {
    const value = result.structuredContent;
    return jsonValueSchema.parse(
      Object.keys(value).length === 1 && "result" in value
        ? value.result
        : value,
    );
  }
  if (blocks.length !== 1)
    throw new AnalysisProtocolError(
      "IDA MCP omitted a single structured or text result; unsupported content cannot establish an empty observation.",
    );
  const values = blocks.map((text): JsonValue => {
    try {
      return jsonValueSchema.parse(JSON.parse(text));
    } catch {
      return text;
    }
  });
  return values[0] ?? null;
};

/** Redact configured transport authentication values from SDK diagnostics only. */
export const redactIdaTransportFailure = (
  cause: unknown,
  config: IdaConfiguration,
): Error => {
  let message =
    cause instanceof Error
      ? cause.message
      : "Unknown IDA MCP transport failure";
  if ("headers" in config) {
    for (const [name, value] of Object.entries(config.headers)) {
      if (!/^(?:authorization|proxy-authorization|cookie)$/iu.test(name))
        continue;
      const credential = value.match(/^(?:Bearer|Basic)\s+([\s\S]+)$/iu)?.[1];
      for (const secret of [value, credential])
        if (secret !== undefined && secret.length > 0)
          message = message
            .split(secret)
            .join("[redacted transport credential]");
    }
  }
  return new Error(message, { cause });
};

/** Create a standard SDK connection to an existing upstream registration. */
export const createIdaMcpConnection = (
  config: IdaConfiguration,
  environment: Readonly<NodeJS.ProcessEnv>,
): IdaMcpConnection => {
  const client = new Client({ name: "rea-ida-provider", version: "1" });
  const transportFailure = (cause: unknown): never => {
    throw redactIdaTransportFailure(cause, config);
  };
  const transport =
    "command" in config
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: {
            // The SDK always merges ambient defaults. Its string-only environment
            // API requires empty values to suppress omitted caller-selected keys.
            ...Object.fromEntries(
              DEFAULT_INHERITED_ENV_VARS.map((key) => [key, ""]),
            ),
            ...Object.fromEntries(
              Object.entries(snapshotEnvironment(environment)).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            IDA_MCP_MAX_WORKERS: "1",
            ...snapshotEnvironment(config.env),
          },
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers, redirect: "error" },
        });
  // Drain proxy diagnostics without persisting ambient environment or transport credentials.
  if (transport instanceof StdioClientTransport)
    transport.stderr?.on("data", () => undefined);
  return {
    async connect() {
      await client
        .connect(transport, { timeout: config.timeoutMs })
        .catch(transportFailure);
      const catalog = await client
        .listTools(undefined, {
          timeout: config.timeoutMs,
        })
        .catch(transportFailure);
      return catalog.tools.map(({ name }) => name);
    },
    async call(name, args) {
      return decodeIdaToolResult(
        await client
          .callTool({ name, arguments: args }, { timeout: config.timeoutMs })
          .catch(transportFailure),
      );
    },
    serverInfo: () => jsonValueSchema.parse(client.getServerVersion() ?? null),
    close: () => client.close().catch(transportFailure),
  };
};
