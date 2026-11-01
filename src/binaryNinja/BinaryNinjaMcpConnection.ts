import {
  Client,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import type { BinaryNinjaConfiguration } from "./BinaryNinjaConfiguration.js";
import { binaryNinjaToolErrorSchema } from "./BinaryNinjaProtocolValues.js";

/** One decoded tool reply: rendered text, structured content, or both. */
export interface BinaryNinjaToolReply {
  readonly text: string | null;
  readonly structured: Readonly<Record<string, JsonValue>> | null;
}

/** Injectable MCP boundary used by the provider and its conformance tests. */
export interface BinaryNinjaMcpConnection {
  /** Initialize and return every advertised tool name. */
  connect(signal?: AbortSignal): Promise<readonly string[]>;
  call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<BinaryNinjaToolReply>;
  serverInfo(): JsonValue;
  close(): Promise<void>;
}

/** A tool error the server reported with its own machine-readable code. */
export class BinaryNinjaToolError extends AnalysisProtocolError {
  constructor(
    readonly tool: string,
    readonly code: string,
    readonly reason: string,
  ) {
    super(`Binary Ninja ${tool} failed with ${code}: ${reason}`, {
      diagnostics: { tool, error_code: code, reason },
    });
  }
}

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(
    z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
  ),
});

const MAX_DIAGNOSTIC_CHARACTERS = 4096;

/** Redact authentication values as Fetch sends them, preserving non-secret headers. */
export const createBinaryNinjaRedactor = (
  headers: Readonly<Record<string, string>> | Headers,
): ((text: string) => string) => {
  const normalized =
    headers instanceof Headers ? headers : new Headers(headers);
  const secrets = [...normalized.entries()]
    .filter(([name]) =>
      ["authorization", "proxy-authorization", "cookie"].includes(name),
    )
    .map(([, value]) => value)
    .flatMap((value) => {
      const bearer = /^Bearer\s+(.+)$/iu.exec(value)?.[1];
      return bearer === undefined ? [value] : [value, bearer];
    })
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  return (text) => {
    let redacted = text;
    for (const secret of secrets)
      redacted = redacted.replaceAll(secret, "[redacted]");
    return redacted.length > MAX_DIAGNOSTIC_CHARACTERS
      ? `${redacted.slice(0, MAX_DIAGNOSTIC_CHARACTERS)}…`
      : redacted;
  };
};

/** Decode one reply. An error result keeps its producer code; content must be text. */
export const decodeBinaryNinjaToolResult = (
  tool: string,
  input: unknown,
  redact: (text: string) => string = (text) => text,
): BinaryNinjaToolReply => {
  const result = toolResultSchema.parse(input);
  if (result.content.some((block) => block.type !== "text"))
    throw new AnalysisProtocolError(
      `Binary Ninja ${tool} returned non-text content.`,
    );
  const text =
    result.content.length === 0
      ? null
      : result.content.map((block) => block.text ?? "").join("\n");
  const structured =
    result.structuredContent === undefined
      ? null
      : jsonObjectSchema.parse(result.structuredContent);
  if (result.isError === true) {
    let error: unknown = structured;
    if (error === null && text !== null)
      try {
        error = JSON.parse(text);
      } catch {
        error = null;
      }
    const parsed = binaryNinjaToolErrorSchema.safeParse(error);
    throw parsed.success
      ? new BinaryNinjaToolError(
          redact(tool),
          redact(parsed.data.errorCode),
          redact(parsed.data.errorMessage),
        )
      : new AnalysisProtocolError(
          `Binary Ninja ${tool} failed without a machine-readable error code.`,
        );
  }
  if (text === null && structured === null)
    throw new AnalysisProtocolError(
      `Binary Ninja ${tool} returned neither text nor structured content.`,
    );
  return { text, structured };
};

/** Create a Streamable HTTP connection to Binary Ninja's GUI MCP server. */
export const createBinaryNinjaMcpConnection = (
  config: BinaryNinjaConfiguration,
): BinaryNinjaMcpConnection => {
  const client = new Client({
    name: "rea-binary-ninja-provider",
    version: "1",
  });
  const headers = new Headers(config.headers);
  const redact = createBinaryNinjaRedactor(headers);
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers, redirect: "error" },
  });
  const throwIfCancelled = (
    operation: string,
    signal: AbortSignal | undefined,
  ): void => {
    if (signal?.aborted === true)
      throw new AnalysisCancelledError(operation, { cause: signal.reason });
  };
  const failure = (
    cause: unknown,
    operation: string,
    signal: AbortSignal | undefined,
  ): never => {
    throwIfCancelled(operation, signal);
    const reason = redact(
      cause instanceof Error
        ? cause.message
        : "Unknown Binary Ninja MCP failure",
    );
    const retained = new Error(reason);
    if (cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout)
      throw new AnalysisTimeoutError(operation, config.timeoutMs, {
        cause: retained,
        remediationAction:
          "Raise timeoutMs in REA_BINARY_NINJA_MCP_CONFIG or wait for Binary Ninja analysis to finish.",
      });
    throw new ProviderAdapterError("binary-ninja", "transport", {
      cause: retained,
      diagnostics: {
        reason,
        recovery:
          "Start the Binary Ninja GUI MCP server (Plugins > MCP > Start Server) and check REA_BINARY_NINJA_MCP_CONFIG; see docs/binary-ninja.md.",
      },
    });
  };
  const options = (signal: AbortSignal | undefined) => ({
    timeout: config.timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });
  let connected = false;
  return {
    async connect(signal) {
      throwIfCancelled("binary_ninja_mcp_connect", signal);
      // A failed target binding may be retried on the same initialized session.
      if (!connected) {
        await client
          .connect(transport, options(signal))
          .catch((cause: unknown) =>
            failure(cause, "binary_ninja_mcp_connect", signal),
          );
        connected = true;
      }
      const names: string[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client
          .listTools(
            cursor === undefined ? undefined : { cursor },
            options(signal),
          )
          .catch((cause: unknown) =>
            failure(cause, "binary_ninja_mcp_catalog", signal),
          );
        names.push(...page.tools.map(({ name }) => name));
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (cursors.has(cursor))
            throw new AnalysisProtocolError(
              "Binary Ninja MCP repeated a tools/list cursor.",
            );
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      return names;
    },
    async call(name, args, signal) {
      throwIfCancelled(name, signal);
      const result = await client
        .callTool({ name, arguments: { ...args } }, options(signal))
        .catch((cause: unknown) => failure(cause, name, signal));
      try {
        return decodeBinaryNinjaToolResult(name, result, redact);
      } catch (cause: unknown) {
        if (cause instanceof BinaryNinjaToolError) throw cause;
        return failure(cause, name, signal);
      }
    },
    serverInfo: () => jsonValueSchema.parse(client.getServerVersion() ?? null),
    close: () =>
      client
        .close()
        .catch((cause: unknown) =>
          failure(cause, "binary_ninja_mcp_close", undefined),
        ),
  };
};
