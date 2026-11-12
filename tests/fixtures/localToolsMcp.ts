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
import { expect, onTestFinished } from "vitest";
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
  // compact-profile catalog tests. SDK callTool validates each successful reply.
  const definitions = new Map(tools.map((tool) => [tool.name, tool]));
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
    // the fixture's independent advertised-schema assertion.
    if (
      (response.isError === true || jsonSchemaValidator !== undefined) &&
      response.structuredContent !== undefined &&
      definition?.outputSchema !== undefined
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
