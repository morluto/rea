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

/** Rewrite the arm64 slice's LC_FUNCTION_STARTS `dataoff` and `datasize`. */
const redirectStarts = (
  image: Buffer,
  dataoff: number,
  datasize: number,
): Buffer => {
  const copy = Buffer.from(image);
  const count = copy.readUInt32LE(16);
  let at = 32;
  for (let index = 0; index < count; index += 1) {
    const command = copy.readUInt32LE(at);
    if (command === 0x26) {
      copy.writeUInt32LE(dataoff, at + 8);
      copy.writeUInt32LE(datasize, at + 12);
      return copy;
    }
    at += copy.readUInt32LE(at + 4);
  }
  throw new Error("fixture has no LC_FUNCTION_STARTS");
};

fileInspectionTest(
  "keeps Evidence ranges inside the selected universal slice",
  async ({ client }) => {
    const root = await createTestTempDirectory(
      "rea-macho-function-starts-mcp-slice-range-",
    );
    const arm = arm64FunctionStartsImage();
    const ranges = async (image: Buffer, name: string) => {
      const path = join(root, name);
      await writeFile(
        path,
        machoFunctionStartsUniversal(image, x64FunctionStartsImage()),
      );
      const response = await client.callTool({
        name: "inspect_macho_function_starts",
        arguments: { path, architecture: "arm64", limit: 0 },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract(
        "inspect_macho_function_starts",
      ).outputSchema.parse(response.structuredContent);
      return {
        report: evidence.normalized_result,
        ranges: evidence.locations.filter(
          (location) => location.kind === "file-offset-range",
        ),
      };
    };
    // The arm64 slice spans [0x1000, 0x6000); the x86_64 slice starts at 0x6000.
    const outside = await ranges(redirectStarts(arm, arm.length, 4), "past");
    expect(outside.report.function_starts).toMatchObject({
      dataoff: arm.length,
      datasize: 4,
      file_offset: 0x1000 + arm.length,
    });
    expect(outside.report.coverage.status).toBe("partial");
    expect(
      outside.ranges.every(
        (range) => "end" in range && range.end <= 0x1000 + arm.length,
      ),
    ).toBe(true);
    expect(
      outside.ranges.some(
        (range) => "start" in range && range.start === 0x1000 + arm.length,
      ),
    ).toBe(false);

    const straddling = await ranges(
      redirectStarts(arm, arm.length - 0x100, 0x400),
      "straddling",
    );
    expect(straddling.report.function_starts).toMatchObject({
      dataoff: arm.length - 0x100,
      datasize: 0x400,
    });
    expect(straddling.ranges).toContainEqual({
      kind: "file-offset-range",
      start: 0x1000 + arm.length - 0x100,
      end: 0x1000 + arm.length,
    });
  },
);
