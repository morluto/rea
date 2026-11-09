import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  UNWIND_FN_A,
  UNWIND_FN_B,
  UNWIND_LSDA,
  elfUnwindFixture,
} from "../../src/native/elf/ElfUnwindTables.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const address = (value: number): string => `0x${value.toString(16)}`;

cliTest(
  "reports two unwind ranges, a symbol, an LSDA, and a header mismatch",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-unwind-cli-");
    const path = join(root, "program");
    await writeFile(path, elfUnwindFixture());
    const result = await cli.run({
      arguments: ["inspect-elf-unwind-ranges", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract(
      "inspect_elf_unwind_ranges",
    ).outputSchema.parse(result.json);
    const report = evidence.normalized_result;
    expect(report.ranges).toHaveLength(2);
    expect(report.ranges[0]).toMatchObject({
      start: address(UNWIND_FN_A),
      symbol: { text: "alpha", trust: "untrusted" },
      lsda: null,
    });
    expect(report.ranges[1]).toMatchObject({
      start: address(UNWIND_FN_B),
      symbol: null,
      lsda: { address: address(UNWIND_LSDA), indirect: false },
    });
    expect(report.coverage).toMatchObject({
      status: "complete",
      total_ranges: 2,
      ranges_with_symbols: 1,
      ranges_without_symbols: 1,
      eh_frame_hdr_agreement: "disagree",
    });
    expect(report.limitations).toContain(
      "The .eh_frame_hdr binary search table does not match the decoded FDEs.",
    );
  },
);

cliTest(
  "resolves a relative ELF path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-unwind-cli-rel-");
    await writeFile(join(root, "program"), elfUnwindFixture());
    const result = await cli.run({
      arguments: ["inspect-elf-unwind-ranges", "program", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract(
      "inspect_elf_unwind_ranges",
    ).outputSchema.parse(result.json);
    expect(evidence.subject?.local_path).toBe(join(root, "program"));
    expect(evidence.normalized_result.coverage.total_ranges).toBe(2);
  },
);

cliTest("reports a non-ELF file as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-elf-unwind-cli-bad-");
  const path = join(root, "broken");
  await writeFile(path, Buffer.from("not an elf"));
  const result = await cli.run({
    arguments: ["inspect-elf-unwind-ranges", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_elf_unwind_ranges" },
  });
});

cliTest("pages unwind ranges with --offset and --limit", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-elf-unwind-cli-page-");
  const path = join(root, "program");
  await writeFile(path, elfUnwindFixture());
  const result = await cli.run({
    arguments: [
      "inspect-elf-unwind-ranges",
      path,
      "--json",
      "--offset",
      "1",
      "--limit",
      "1",
    ],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_elf_unwind_ranges").outputSchema.parse(
    result.json,
  );
  expect(evidence.normalized_result.ranges.map((range) => range.index)).toEqual(
    [1],
  );
  expect(evidence.normalized_result.ranges[0]?.start).toBe(
    address(UNWIND_FN_B),
  );
  expect(evidence.normalized_result.page).toEqual({
    offset: 1,
    limit: 1,
    returned: 1,
    total: 2,
    next_offset: null,
  });
  expect(evidence.normalized_result.coverage.total_ranges).toBe(2);
});

cliTest("decodes an ELF32 big-endian unwind table", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-elf-unwind-cli-be-");
  const path = join(root, "program");
  await writeFile(
    path,
    elfUnwindFixture({ bits: 32, little: false, machine: 20, header: "match" }),
  );
  const result = await cli.run({
    arguments: ["inspect-elf-unwind-ranges", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_elf_unwind_ranges").outputSchema.parse(
    result.json,
  );
  expect(evidence.normalized_result.format).toBe("elf32");
  expect(evidence.normalized_result.byte_order).toBe("big");
  expect(evidence.normalized_result.machine).toBe(20);
  expect(evidence.normalized_result.ranges.map((range) => range.start)).toEqual(
    [address(UNWIND_FN_A), address(UNWIND_FN_B)],
  );
  expect(evidence.normalized_result.coverage.eh_frame_hdr_agreement).toBe(
    "agree",
  );
});
