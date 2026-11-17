import {
  canonicalOutputSchema,
  withCanonicalOutputSchema,
} from "./canonicalOutputSchema.js";
import {
  Client,
  type CallToolRequestOptions,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import { closeVerifierResources } from "../../scripts/lib/verifier-cleanup.mjs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, onTestFinished } from "vitest";
import { createMcpSchemaValidation } from "./mcpSchemaValidation.js";

/** Default to native tools while preserving explicit caller configuration. */
export const localToolsMcpEnvironment = (
  environment: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  REA_LOG_LEVEL: "silent",
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
  GHIDRA_INSTALL_DIR: process.execPath,
  ...environment,
});

/** Start the built production server without configuring deep binary providers. */
export async function connectLocalToolsMcp(
  environment: Readonly<Record<string, string>> = {},
  registerCleanup: (cleanup: () => Promise<void>) => void = onTestFinished,
  transportOptions: Readonly<Pick<StdioServerParameters, "maxBufferSize">> = {},
  jsonSchemaValidator?: NonNullable<ClientOptions["jsonSchemaValidator"]>,
) {
  const transport = new StdioClientTransport({
    ...transportOptions,
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
      "mcp",
    ],
    env: localToolsMcpEnvironment(environment),
    stderr: "pipe",
  });
  const validation = createMcpSchemaValidation();
  const client = new Client(
    { name: "local-tools-e2e", version: "1" },
    { jsonSchemaValidator: jsonSchemaValidator ?? validation },
  );
  registerCleanup(async () => {
    await closeVerifierResources([
      () => client.close(),
      () => transport.close(),
      () => validation.clear(),
    ]);
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  // Catalog dialect/reference validity belongs to toolSchemaValidity and the
  // compact-profile catalog tests.
  // tools/list omits output schemas by default; bind each definition to its
  // canonical output contract so the SDK client validates successful replies.
  const definitions = new Map(
    tools.map((tool) => [tool.name, withCanonicalOutputSchema(tool)]),
  );
  const call = async (
    name: string,
    arguments_: Record<string, unknown>,
    options?: Pick<CallToolRequestOptions, "signal" | "onprogress">,
  ) => {
    const definition = definitions.get(name);
    const response = await client.callTool(
      { name, arguments: arguments_ },
      {
        ...options,
        ...(definition === undefined ? {} : { toolDefinition: definition }),
      },
    );
    // The SDK skips error payloads. A caller-supplied validator also retains
    // the fixture's independent canonical-schema assertion.
    if (
      (response.isError === true || jsonSchemaValidator !== undefined) &&
      response.structuredContent !== undefined &&
      definition !== undefined
    ) {
      expect(
        validation.assertions.validate(
          definition.outputSchema,
          response.structuredContent,
        ),
        JSON.stringify(validation.assertions.errors),
      ).toBe(true);
    }
    return response;
  };
  return { client, call };
}

/**
 * Lazy file-scoped production stdio MCP client. Connects on first use so
 * skipped files pay zero startup cost, and drains cleanups in LIFO order while
 * retaining any cleanup that fails.
 */
export const lazyLocalToolsMcp = (
  environment: Readonly<Record<string, string>> = {},
): (() => Promise<Awaited<ReturnType<typeof connectLocalToolsMcp>>>) => {
  type ConnectedLocalToolsMcp = Awaited<
    ReturnType<typeof connectLocalToolsMcp>
  >;
  let pending: Promise<ConnectedLocalToolsMcp> | undefined;
  let closed = false;
  const cleanups: Array<() => Promise<void>> = [];
  const drain = async (): Promise<void> => {
    const failures: unknown[] = [];
    const retained: Array<() => Promise<void>> = [];
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup === undefined) break;
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
        retained.push(cleanup);
      }
    }
    for (const cleanup of retained.reverse()) cleanups.push(cleanup);
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "File-scoped MCP session cleanup failed",
      );
    }
    if (failures.length === 1) throw failures[0];
  };
  afterAll(async () => {
    closed = true;
    if (pending !== undefined) await pending.catch(() => undefined);
    await drain();
  });
  return () => {
    if (closed) {
      return Promise.reject(new Error("File-scoped MCP session is closed"));
    }
    pending ??= (async () => {
      if (cleanups.length > 0) await drain();
      if (closed) throw new Error("File-scoped MCP session is closed");
      try {
        const opened = await connectLocalToolsMcp(environment, (cleanup) => {
          cleanups.push(cleanup);
        });
        if (closed) throw new Error("File-scoped MCP session is closed");
        return opened;
      } catch (error) {
        if (!closed) {
          pending = undefined;
          await drain().catch(() => undefined);
        }
        throw error;
      }
    })();
    return pending;
  };
};

/**
 * One production stdio MCP client for the calling test file. It connects
 * before the file's tests. Teardown removes each cleanup only after it
 * succeeds, so a failed cleanup stays owned.
 */
export const fileLocalToolsMcp = (
  environment: Readonly<Record<string, string>> = {},
) => {
  let connected: Awaited<ReturnType<typeof connectLocalToolsMcp>> | undefined;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    connected = await connectLocalToolsMcp(environment, (cleanup) => {
      cleanups.push(cleanup);
    });
  });
  afterAll(async () => {
    for (let cleanup = cleanups.at(-1); cleanup; cleanup = cleanups.at(-1)) {
      await cleanup();
      cleanups.pop();
    }
  });
  return {
    get client() {
      if (connected === undefined)
        throw new Error("The file's MCP client is not connected");
      return connected.client;
    },
    get call() {
      if (connected === undefined)
        throw new Error("The file's MCP client is not connected");
      return connected.call;
    },
  };
};
