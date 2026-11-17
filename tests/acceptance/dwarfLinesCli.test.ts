import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { dwarfLinesSchema } from "../../src/domain/native/dwarfLines.js";
import {
  buildStringTable,
  elfDebugLineImage,
  elfImage,
  lineProgram,
  lneEndSequence,
  lneSetAddress,
  lnsCopy,
  lnsSetFile,
  macho64,
} from "../../src/native/dwarf/DwarfLines.fixture.js";
import {
  CPU_ARM64,
  CPU_X86_64,
  universalMacho,
} from "../fixtures/universalMacho.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const dwarfLinesContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_dwarf_lines",
);

cliTest(
  "decodes DWARF 5 line programs, MD5 digests, and address attributions through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dwarf-lines-cli-");
    const path = join(root, "program");
    const strings = buildStringTable(["/repo", "main.c"]);
    const md5 = "00112233445566778899aabbccddeeff";
    const line = lineProgram({
      version: 5,
      addressSize: 8,
      includeMd5: true,
      v5Directories: [{ form: 0x1f, lineStrp: strings.offsets[0]! }],
      v5Files: [
        {
          path: { form: 0x1f, lineStrp: strings.offsets[1]! },
          dirIndex: 0,
          md5Hex: md5,
        },
      ],
      opcodes: Buffer.concat([
        lneSetAddress(0x401000n, 8, true),
        lnsSetFile(0),
        lnsCopy(),
        lneSetAddress(0x401010n, 8, true),
        lneEndSequence(),
      ]),
    });
    await writeFile(
      path,
      elfDebugLineImage({ line, lineStr: strings.table }, { type: 2 }),
    );
    const result = await cli.run({
      arguments: [
        "inspect-dwarf-lines",
        path,
        "--addresses",
        "0x401004",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = dwarfLinesContract.outputSchema.parse(result.json);
    const report = dwarfLinesSchema.parse(evidence.normalized_result);
    expect(report.programs[0]?.files[0]?.md5_hex).toBe(md5);
    expect(report.address_matches[0]).toMatchObject({
      query_address: "0x401004",
      status: "resolved",
      matches: [{ path: "/repo/main.c", line: 1, exact: false }],
    });
    expect(evidence.parameters).toEqual({ path, addresses: ["0x401004"] });
    expect(evidence.subject?.identity).toMatchObject({ format: "elf" });
  },
);

cliTest(
  "resolves a relative path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dwarf-lines-cli-rel-");
    await writeFile(join(root, "plain"), elfImage());
    const result = await cli.run({
      arguments: ["inspect-dwarf-lines", "plain", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = dwarfLinesContract.outputSchema.parse(result.json);
    const report = dwarfLinesSchema.parse(evidence.normalized_result);
    expect(report.debug_line).toBe("absent");
    expect(evidence.subject?.local_path).toBe(join(root, "plain"));
  },
);

cliTest("requires an architecture for a universal Mach-O", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-dwarf-lines-cli-fat-");
  const path = join(root, "universal");
  await writeFile(
    path,
    universalMacho([
      {
        bytes: macho64({ cpuType: CPU_X86_64 }),
        cpuType: CPU_X86_64,
        cpuSubtype: 0,
      },
      {
        bytes: macho64({ cpuType: CPU_ARM64 }),
        cpuType: CPU_ARM64,
        cpuSubtype: 0,
      },
    ]).bytes,
  );
  const result = await cli.run({
    arguments: ["inspect-dwarf-lines", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_dwarf_lines" },
  });
});
