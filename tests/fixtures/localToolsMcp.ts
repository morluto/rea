import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";

/** Start the built production server without configuring deep binary providers. */
export async function connectLocalToolsMcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
      "mcp",
    ],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      REA_LOG_LEVEL: "silent",
      HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "local-tools-e2e", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const validators = new Map(
    tools.flatMap((tool) => {
      new Ajv2020({ strict: false, validateFormats: false }).compile(
        tool.inputSchema,
      );
      return tool.outputSchema === undefined
        ? []
        : [
            [
              tool.name,
              new Ajv2020({ strict: false, validateFormats: false }).compile(
                z.record(z.string(), z.unknown()).parse(tool.outputSchema),
              ),
            ] as const,
          ];
    }),
  );
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: arguments_ });
    const validate = validators.get(name);
    if (
      response.isError !== true &&
      response.structuredContent !== undefined &&
      validate !== undefined
    )
      expect(
        validate(response.structuredContent),
        JSON.stringify(validate.errors),
      ).toBe(true);
    return response;
  };
  return { client, call };
}
