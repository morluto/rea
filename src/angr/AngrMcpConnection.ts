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
import type { AngrConfiguration } from "./AngrConfiguration.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";

/** Injectable MCP boundary used by the provider and its conformance tests. */
export interface AngrMcpConnection {
  connect(): Promise<readonly string[]>;
  call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
    options?: { readonly timeoutMs?: number },
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
});

/** Decode FastMCP's structured result, unwrapping its scalar `result` envelope. */
export const decodeAngrToolResult = (input: unknown): JsonValue => {
  const result = toolResultSchema.parse(input);
  const blocks = result.content.flatMap((block) =>
    block.type === "text" && block.text !== undefined ? [block.text] : [],
  );
  if (result.isError === true)
    throw new AnalysisProtocolError(
      `angr MCP tool failed: ${blocks.join("\n")}`,
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
      "angr MCP omitted a single structured or text result; unsupported content cannot establish an empty observation.",
    );
  try {
    return jsonValueSchema.parse(JSON.parse(blocks[0] ?? ""));
  } catch (cause: unknown) {
    throw new AnalysisProtocolError("angr MCP returned malformed JSON text.", {
      cause,
    });
  }
};

/** Redact configured transport authentication values from SDK diagnostics only. */
export const redactAngrTransportFailure = (
  cause: unknown,
  config: AngrConfiguration,
): Error => {
  let message =
    cause instanceof Error
      ? cause.message
      : "Unknown angr MCP transport failure";
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

/** Create a standard SDK connection to an angr MCP registration. */
export const createAngrMcpConnection = (
  config: AngrConfiguration,
  environment: Readonly<NodeJS.ProcessEnv>,
): AngrMcpConnection => {
  const client = new Client({ name: "rea-angr-provider", version: "1" });
  const transportFailure = (cause: unknown): never => {
    throw redactAngrTransportFailure(cause, config);
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
            ...Object.fromEntries(
              Object.entries(snapshotEnvironment(config.env)).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          },
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers, redirect: "error" },
        });
  // Drain angr's logging without persisting ambient environment or credentials.
  if (transport instanceof StdioClientTransport)
    transport.stderr?.on("data", () => undefined);
  return {
    async connect() {
      await client
        .connect(transport, { timeout: config.timeoutMs })
        .catch(transportFailure);
      const catalog = await client
        .listTools(undefined, { timeout: config.timeoutMs })
        .catch(transportFailure);
      return catalog.tools.map(({ name }) => name);
    },
    async call(name, args, options) {
      return decodeAngrToolResult(
        await client
          .callTool(
            { name, arguments: args },
            { timeout: options?.timeoutMs ?? config.timeoutMs },
          )
          .catch(transportFailure),
      );
    },
    serverInfo: () => jsonValueSchema.parse(client.getServerVersion() ?? null),
    close: () => client.close().catch(transportFailure),
  };
};
