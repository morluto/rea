import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  ARM64_DELTAS,
  arm64FunctionStartsImage,
  functionStartAddresses,
  machoFunctionStartsUniversal,
  x64FunctionStartsImage,
} from "../../../src/native/apple/MachoFunctionStarts.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fileInspectionTest } from "../../support/mcp/fileInspection.js";

const hex = (value: bigint): string => `0x${value.toString(16)}`;

fileInspectionTest(
  "advertises inspect_macho_function_starts and decodes one slice",
  async ({ client }) => {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_macho_function_starts",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    const root = await createTestTempDirectory(
      "rea-macho-function-starts-mcp-",
    );
    const path = join(root, "program");
    await writeFile(path, arm64FunctionStartsImage());
    const response = await client.callTool({
      name: "inspect_macho_function_starts",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = toolContract(
      "inspect_macho_function_starts",
    ).outputSchema.parse(response.structuredContent);
    const report = evidence.normalized_result;
    expect(report.format).toBe("macho");
    expect(report.architecture).toBe("arm64");
    expect(report.starts.map((start) => start.vmaddr)).toEqual(
      functionStartAddresses(ARM64_DELTAS).map(hex),
    );
    expect(report.data_in_code_entries[2]).toMatchObject({
      kind: 0x42,
      owner: { index: 2 },
    });
    expect(report.coverage.status).toBe("complete");
  },
);

fileInspectionTest("pages one function start over MCP", async ({ client }) => {
  const root = await createTestTempDirectory(
    "rea-macho-function-starts-mcp-page-",
  );
  const path = join(root, "program");
  await writeFile(path, arm64FunctionStartsImage());
  const response = await client.callTool({
    name: "inspect_macho_function_starts",
    arguments: { path, kind: "starts", offset: 1, limit: 1 },
  });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const evidence = toolContract(
    "inspect_macho_function_starts",
  ).outputSchema.parse(response.structuredContent);
  expect(
    evidence.normalized_result.starts.map((start) => start.vmaddr),
  ).toEqual([hex(functionStartAddresses(ARM64_DELTAS)[1]!)]);
  expect(evidence.normalized_result.page).toMatchObject({
    kind: "starts",
    offset: 1,
    limit: 1,
    returned_starts: 1,
    total_starts: 3,
    next_starts_offset: 2,
    returned_data: 0,
    next_data_offset: null,
  });
});

fileInspectionTest(
  "reads the selected universal slice over MCP",
  async ({ client }) => {
    const root = await createTestTempDirectory(
      "rea-macho-function-starts-mcp-fat-",
    );
    const path = join(root, "universal");
    await writeFile(
      path,
      machoFunctionStartsUniversal(
        arm64FunctionStartsImage(),
        x64FunctionStartsImage(),
      ),
    );
    const response = await client.callTool({
      name: "inspect_macho_function_starts",
      arguments: { path, architecture: "arm64", limit: 0 },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = toolContract(
      "inspect_macho_function_starts",
    ).outputSchema.parse(response.structuredContent);
    expect(evidence.subject.identity).toMatchObject({
      format: "mach-o-universal",
      architecture: "arm64",
    });
    expect(evidence.normalized_result.coverage).toMatchObject({
      status: "complete",
      total_starts: 3,
      total_data_in_code: 3,
    });
    expect(evidence.normalized_result.starts).toEqual([]);
    expect(evidence.normalized_result.selected_slice).toMatchObject({
      offset: 0x1000,
    });
  },
);
