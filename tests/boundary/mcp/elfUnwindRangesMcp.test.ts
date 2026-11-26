import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  UNWIND_FN_A,
  UNWIND_FN_B,
  UNWIND_LSDA,
  elfUnwindFixture,
} from "../../../src/native/elf/ElfUnwindTables.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fileInspectionTest } from "../../support/mcp/fileInspection.js";

const address = (value: number): string => `0x${value.toString(16)}`;

fileInspectionTest(
  "advertises inspect_elf_unwind_ranges and reads FDE ranges",
  async ({ client }) => {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_elf_unwind_ranges",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    const root = await createTestTempDirectory("rea-elf-unwind-mcp-");
    const path = join(root, "program");
    await writeFile(path, elfUnwindFixture());
    const response = await client.callTool({
      name: "inspect_elf_unwind_ranges",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = toolContract(
      "inspect_elf_unwind_ranges",
    ).outputSchema.parse(response.structuredContent);
    const report = evidence.normalized_result;
    expect(report.format).toBe("elf64");
    expect(report.ranges[0]).toMatchObject({
      start: address(UNWIND_FN_A),
      symbol: { text: "alpha", trust: "untrusted" },
    });
    expect(report.ranges[1]?.lsda).toEqual({
      address: address(UNWIND_LSDA),
      indirect: false,
    });
    expect(report.coverage.eh_frame_hdr_agreement).toBe("disagree");
    expect(report.limitations).toContain(
      "CFA instructions are counted but not evaluated.",
    );
  },
);

fileInspectionTest("pages one unwind range over MCP", async ({ client }) => {
  const root = await createTestTempDirectory("rea-elf-unwind-mcp-page-");
  const path = join(root, "program");
  await writeFile(path, elfUnwindFixture());
  const response = await client.callTool({
    name: "inspect_elf_unwind_ranges",
    arguments: { path, offset: 1, limit: 1 },
  });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const evidence = toolContract("inspect_elf_unwind_ranges").outputSchema.parse(
    response.structuredContent,
  );
  expect(evidence.normalized_result.ranges.map((range) => range.start)).toEqual(
    [address(UNWIND_FN_B)],
  );
  expect(evidence.normalized_result.page).toMatchObject({
    offset: 1,
    limit: 1,
    returned: 1,
    total: 2,
    next_offset: null,
  });
});

fileInspectionTest(
  "decodes an ELF32 big-endian unwind table over MCP",
  async ({ client }) => {
    const root = await createTestTempDirectory("rea-elf-unwind-mcp-be-");
    const path = join(root, "program");
    await writeFile(
      path,
      elfUnwindFixture({
        bits: 32,
        little: false,
        machine: 20,
        header: "match",
      }),
    );
    const response = await client.callTool({
      name: "inspect_elf_unwind_ranges",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = toolContract(
      "inspect_elf_unwind_ranges",
    ).outputSchema.parse(response.structuredContent);
    expect(evidence.normalized_result).toMatchObject({
      format: "elf32",
      byte_order: "big",
      machine: 20,
    });
    expect(evidence.normalized_result.coverage.eh_frame_hdr_agreement).toBe(
      "agree",
    );
  },
);
