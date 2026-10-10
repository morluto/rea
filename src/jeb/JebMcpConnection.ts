import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";

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
  interface ConnectionState {
    readonly client: Client;
    readonly transport: StreamableHTTPClientTransport;
    readonly signal: AbortController;
    tools: readonly string[] | undefined;
    acquisition: Promise<readonly string[]> | undefined;
    disposal: Promise<void> | undefined;
  }
  let state: ConnectionState | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;

  const waitForCaller = <Value>(
    promise: Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> => {
    if (signal?.aborted === true)
      return Promise.reject(new AnalysisCancelledError("jeb_mcp"));
    if (signal === undefined) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(new AnalysisCancelledError("jeb_mcp"));
      };
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (cause: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(cause);
        },
      );
    });
  };

  const dispose = async (owner: ConnectionState): Promise<void> => {
    if (owner.disposal !== undefined) return owner.disposal;
    const cleanup = (async () => {
      const settled = await Promise.allSettled([
        owner.client.close(),
        owner.transport.close(),
      ]);
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "JEB MCP connection cleanup failed");
      if (state === owner) state = undefined;
    })();
    owner.disposal = cleanup;
    try {
      await cleanup;
    } catch (cause: unknown) {
      owner.disposal = undefined;
      throw cause;
    }
  };

  const connect = async (signal?: AbortSignal): Promise<readonly string[]> => {
    if (signal?.aborted === true) throw new AnalysisCancelledError("jeb_mcp");
    if (closing !== undefined) await closing;
    if (closed) {
      if (state !== undefined) await dispose(state);
      throw new AnalysisProtocolError("JEB MCP connection is closed");
    }
    if (state?.tools !== undefined && state.disposal === undefined)
      return state.tools;
    if (state?.acquisition !== undefined)
      return waitForCaller(state.acquisition, signal);
    if (state !== undefined) {
      await dispose(state);
      if (state !== undefined || closing !== undefined) return connect(signal);
    }
    const owner: ConnectionState = {
      client: new Client({
        name: "rea-jeb",
        version: "0.0.0",
      }),
      transport: new StreamableHTTPClientTransport(endpoint, {
        requestInit: { redirect: "error" },
      }),
      signal: new AbortController(),
      tools: undefined,
      acquisition: undefined,
      disposal: undefined,
    };
    state = owner;
    const acquisition = (async () => {
      try {
        await owner.client.connect(owner.transport, {
          signal: owner.signal.signal,
        });
        const listing = await owner.client.listTools(
          {},
          { signal: owner.signal.signal },
        );
        const tools = listing.tools.map((tool) => tool.name);
        owner.tools = tools;
        return tools;
      } catch (cause: unknown) {
        owner.signal.abort(cause);
        try {
          await dispose(owner);
        } catch (cleanupCause: unknown) {
          throw new AggregateError(
            [cause, cleanupCause],
            "JEB MCP connection acquisition and cleanup failed",
            { cause },
          );
        }
        throw cause;
      }
    })();
    owner.acquisition = acquisition;
    void acquisition.then(
      () => {
        if (owner.acquisition === acquisition) owner.acquisition = undefined;
      },
      () => {
        if (owner.acquisition === acquisition) owner.acquisition = undefined;
      },
    );
    return waitForCaller(acquisition, signal);
  };

  return {
    connect,
    async call(name, args, signal) {
      await connect(signal);
      const owner = state;
      if (owner === undefined || owner.tools === undefined)
        throw new AnalysisProtocolError("JEB MCP client failed to connect");
      const result = await owner.client.callTool(
        { name, arguments: args },
        signal === undefined ? {} : { signal },
      );
      return decodeJebToolResult(result);
    },
    async close() {
      closed = true;
      if (closing !== undefined) return closing;
      const operation = (async () => {
        const owner = state;
        if (owner === undefined) return;
        owner.tools = undefined;
        owner.signal.abort();
        if (owner.acquisition !== undefined)
          await owner.acquisition.catch(() => undefined);
        if (state === owner) await dispose(owner);
      })();
      closing = operation;
      try {
        await operation;
      } finally {
        if (closing === operation) closing = undefined;
      }
    },
  };
};
