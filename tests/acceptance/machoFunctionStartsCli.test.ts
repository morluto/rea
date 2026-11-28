import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  arm64FunctionStartsImage,
  functionStartAddresses,
  ARM64_DELTAS,
  X64_DELTAS,
  machoFunctionStartsUniversal,
  x64FunctionStartsImage,
} from "../../src/native/apple/MachoFunctionStarts.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  expectAdapterErrorParity,
  parseMcpToolError,
} from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

const hex = (value: bigint): string => `0x${value.toString(16)}`;

cliTest(
  "reads Mach-O function starts identically over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-macho-function-starts-cli-",
    );
    const path = join(root, "program");
    const bytes = arm64FunctionStartsImage();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: [
        "inspect-macho-function-starts",
        path,
        "--kind",
        "starts",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract(
      "inspect_macho_function_starts",
    ).outputSchema.parse(result.json);
    expect(evidence.operation).toBe("inspect_macho_function_starts");
    expect(evidence.normalized_result.coverage).toMatchObject({
      status: "complete",
      total_starts: 3,
      total_data_in_code: 3,
    });
    expect(
      evidence.normalized_result.starts.map((start) => start.vmaddr),
    ).toEqual(functionStartAddresses(ARM64_DELTAS).map(hex));
    expect(evidence.normalized_result.data_in_code_entries).toEqual([]);

    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_macho_function_starts", {
      path,
      kind: "starts",
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const mcpEvidence = toolContract(
      "inspect_macho_function_starts",
    ).outputSchema.parse(response.structuredContent);
    expect(mcpEvidence.normalized_result).toEqual(evidence.normalized_result);
    expect((await readFile(path)).equals(bytes)).toBe(true);

    const universal = join(root, "universal");
    const fat = machoFunctionStartsUniversal(bytes, x64FunctionStartsImage());
    await writeFile(universal, fat);
    const selected = await cli.run({
      arguments: [
        "inspect-macho-function-starts",
        universal,
        "--architecture",
        "x86_64",
        "--json",
      ],
    });
    expect(selected.exitCode, selected.stderr).toBe(0);
    const slice = toolContract(
      "inspect_macho_function_starts",
    ).outputSchema.parse(selected.json);
    expect(slice.subject.identity).toMatchObject({
      format: "mach-o-universal",
      architecture: "x86_64",
    });
    expect(slice.normalized_result.starts.map((start) => start.vmaddr)).toEqual(
      functionStartAddresses(X64_DELTAS).map(hex),
    );

    const truncated = join(root, "truncated");
    await writeFile(truncated, bytes.subarray(0, 20));
    const refused = await cli.run({
      arguments: ["inspect-macho-function-starts", truncated, "--json"],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      details: { operation: "inspect_macho_function_starts", path: truncated },
    });
    const mcpRefused = await call("inspect_macho_function_starts", {
      path: truncated,
    });
    expect(mcpRefused.isError).toBe(true);
    expectAdapterErrorParity(
      parseMcpToolError(mcpRefused).error,
      refused.json,
      "inspect_macho_function_starts",
    );
  },
);
