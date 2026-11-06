import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { RequestTrackingMcpServer } from "../../../src/server/RequestTrackingMcpServer.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

const TOOLS = [
  "inspect_apple_ips",
  "inspect_elf_notes",
  "inspect_kernel_module",
  "inspect_byte_entropy",
  "export_web_scripts",
  "recover_javascript_sources",
] as const;

const absoluteFile =
  process.platform === "win32" ? "C:\\sample.bin" : "/tmp/sample.bin";
const absoluteDirectory = process.platform === "win32" ? "C:\\out" : "/tmp/out";

const relativeInput = (
  name: (typeof TOOLS)[number],
): Record<string, unknown> => {
  if (name === "export_web_scripts")
    return {
      capture_path: "sample.bin",
      output_directory: absoluteDirectory,
    };
  if (name === "recover_javascript_sources")
    return {
      path: "sample.bin",
      output_directory: absoluteDirectory,
      additional_paths: ["sample.bin"],
    };
  return { path: "sample.bin" };
};

const absoluteInput = (
  name: (typeof TOOLS)[number],
): Record<string, unknown> => {
  if (name === "export_web_scripts")
    return {
      capture_path: absoluteFile,
      output_directory: absoluteDirectory,
    };
  if (name === "recover_javascript_sources")
    return {
      path: absoluteFile,
      output_directory: absoluteDirectory,
      additional_paths: [absoluteFile],
    };
  return { path: absoluteFile };
};

it("rejects a relative sample.bin on tools/list for absolute path tools", async () => {
  const server = new RequestTrackingMcpServer({
    name: "absolute-path-schema",
    version: "1",
  });
  for (const name of TOOLS) {
    const contract = toolContract(name);
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      () => ({
        content: [],
      }),
    );
  }
  const client = new Client({ name: "absolute-path-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    for (const name of TOOLS) {
      const schema = listed.tools.find(
        (tool) => tool.name === name,
      )?.inputSchema;
      expect(schema, name).toBeDefined();
      if (schema === undefined) continue;
      const validate = ajv.compile(schema as AnySchema);
      expect(validate(relativeInput(name)), name).toBe(false);
      expect(validate(absoluteInput(name)), `${name} ${ajv.errorsText()}`).toBe(
        true,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});
