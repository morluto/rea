import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { expect, it } from "vitest";

import { JAVASCRIPT_RECOVERY_TOOL_CONTRACTS } from "../../../src/contracts/javascript/javascriptRecoveryToolContracts.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { WEB_SCRIPT_TOOL_CONTRACTS } from "../../../src/contracts/webScriptToolContracts.js";
import { API_CONTRACT_TOOL_CONTRACTS } from "../../../src/contracts/apiContractToolContracts.js";
import { PLAYWRIGHT_TRACE_TOOL_CONTRACTS } from "../../../src/contracts/playwrightTraceToolContracts.js";
import { PYTHON_PYC_TOOL_CONTRACTS } from "../../../src/contracts/python/pythonPycToolContracts.js";
import { RequestTrackingMcpServer } from "../../../src/server/RequestTrackingMcpServer.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

const CONTRACTS = [
  ...BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  ...WEB_SCRIPT_TOOL_CONTRACTS,
  ...JAVASCRIPT_RECOVERY_TOOL_CONTRACTS,
  ...API_CONTRACT_TOOL_CONTRACTS,
  ...PLAYWRIGHT_TRACE_TOOL_CONTRACTS,
  ...PYTHON_PYC_TOOL_CONTRACTS,
];

const PATH_FIELDS = {
  inspect_apple_ips: ["path"],
  inspect_elf_notes: ["path"],
  inspect_elf_unwind_ranges: ["path"],
  inspect_kernel_module: ["path"],
  inspect_byte_entropy: ["path"],
  inspect_api_contract: ["path", "operations_path"],
  inspect_devicetree: ["path"],
  inspect_playwright_trace: ["path"],
  inspect_python_pyc: ["path"],
  export_web_scripts: ["capture_path", "output_directory"],
  recover_javascript_sources: ["path", "output_directory", "additional_paths"],
} as const;

const absoluteFile =
  process.platform === "win32" ? "C:\\sample.bin" : "/tmp/sample.bin";
const absoluteDirectory = process.platform === "win32" ? "C:\\out" : "/tmp/out";

const contractFor = (name: keyof typeof PATH_FIELDS) => {
  const contract = CONTRACTS.find((candidate) => candidate.name === name);
  if (contract === undefined) throw new Error(`Missing contract ${name}`);
  return contract;
};

const validInput = (
  name: keyof typeof PATH_FIELDS,
): Record<string, unknown> => {
  if (name === "inspect_api_contract")
    return {
      format: "graphql-sdl",
      path: absoluteFile,
      operations_path: absoluteFile,
    };
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

const withRelativeField = (
  name: keyof typeof PATH_FIELDS,
  field: string,
): Record<string, unknown> => ({
  ...validInput(name),
  [field]: field === "additional_paths" ? ["sample.bin"] : "sample.bin",
});

it("rejects one relative path field at a time on tools/list", async () => {
  const server = new RequestTrackingMcpServer({
    name: "absolute-path-schema",
    version: "1",
  });
  for (const name of Object.keys(PATH_FIELDS) as (keyof typeof PATH_FIELDS)[]) {
    const contract = contractFor(name);
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      () => ({ content: [] }),
    );
  }
  const client = new Client({ name: "absolute-path-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const checked: string[] = [];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    for (const name of Object.keys(
      PATH_FIELDS,
    ) as (keyof typeof PATH_FIELDS)[]) {
      const schema = listed.tools.find(
        (tool) => tool.name === name,
      )?.inputSchema;
      expect(schema, name).toBeDefined();
      if (schema === undefined) throw new Error(`Missing schema ${name}`);
      const validate = ajv.compile(schema as AnySchema);
      expect(validate(validInput(name)), `${name} valid`).toBe(true);
      for (const field of PATH_FIELDS[name]) {
        expect(
          validate(withRelativeField(name, field)),
          `${name}.${field}`,
        ).toBe(false);
        checked.push(`${name}.${field}`);
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
  expect(checked).toEqual([
    "inspect_apple_ips.path",
    "inspect_elf_notes.path",
    "inspect_elf_unwind_ranges.path",
    "inspect_kernel_module.path",
    "inspect_byte_entropy.path",
    "inspect_api_contract.path",
    "inspect_api_contract.operations_path",
    "inspect_devicetree.path",
    "inspect_playwright_trace.path",
    "inspect_python_pyc.path",
    "export_web_scripts.capture_path",
    "export_web_scripts.output_directory",
    "recover_javascript_sources.path",
    "recover_javascript_sources.output_directory",
    "recover_javascript_sources.additional_paths",
  ]);
});
