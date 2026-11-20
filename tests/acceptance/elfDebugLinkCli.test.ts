import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import {
  debuglinkSection,
  elfDebugCandidateFixture,
  elfDebugLinkFixture,
  FIXTURE_BUILD_ID_HEX,
  FIXTURE_DEBUG_NAME,
} from "../../src/native/elf/ElfDebugLink.fixture.js";
import {
  compressedElfNoteSectionFixture,
  gnuBuildIdNote,
  withElf64DirectSectionCount,
} from "../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const debugLinkContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_elf_debug_link",
);

cliTest(
  "verifies a matching debug file from absolute and relative paths",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-debug-link-cli-");
    const candidate = elfDebugCandidateFixture();
    const image = elfDebugLinkFixture({
      debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, 0xae159abd, true),
    });
    const imagePath = join(root, "prog");
    const candidatePath = join(root, "prog.debug");
    await writeFile(imagePath, image);
    await writeFile(candidatePath, candidate);
    const absolute = await cli.run({
      arguments: [
        "inspect-elf-debug-link",
        imagePath,
        "--candidate-path",
        candidatePath,
        "--json",
      ],
    });
    expect(absolute.exitCode, absolute.stderr).toBe(0);
    const evidence = debugLinkContract.outputSchema.parse(absolute.json);
    expect(evidence.parameters).toEqual({
      path: imagePath,
      candidate_path: candidatePath,
    });
    expect(evidence.normalized_result.verification).toMatchObject({
      status: "matches",
      reason: null,
      crc32: {
        status: "match",
        expected_hex: "ae159abd",
        observed_hex: "ae159abd",
      },
      build_id: { status: "match", candidate_hex: FIXTURE_BUILD_ID_HEX },
    });
    expect(evidence.normalized_result.candidate).toMatchObject({
      path: candidatePath,
      format: "elf64",
      debug_info: "present",
      symtab: "present",
    });
    expect(evidence.normalized_result.debuglink.crc32_hex).toBe("ae159abd");
    expect(evidence.normalized_result.build_id.hex).toBe(FIXTURE_BUILD_ID_HEX);
    expect(evidence.normalized_result.debuglink.filename?.trust).toBe(
      "observed-untrusted",
    );
    // Spelled out from the selected image directory, not by the derivation.
    const directory = dirname(imagePath);
    const globalDirectory =
      process.platform === "win32"
        ? `${directory.slice(0, 1)}/${directory.slice(3).replaceAll("\\", "/")}`
        : directory.slice(1);
    const separator = process.platform === "win32" ? "\\" : "/";
    expect(evidence.normalized_result.lookup_paths).toEqual(
      [
        [
          "build_id",
          `/usr/lib/debug/.build-id/${FIXTURE_BUILD_ID_HEX.slice(0, 2)}/${FIXTURE_BUILD_ID_HEX.slice(2)}.debug`,
        ],
        [
          "debug_subdirectory",
          `${directory}${separator}.debug${separator}${FIXTURE_DEBUG_NAME}`,
        ],
        [
          "global_debug_directory",
          `/usr/lib/debug/${globalDirectory}/${FIXTURE_DEBUG_NAME}`,
        ],
      ].map(([kind, path]) => ({ kind, path, trust: "observed-untrusted" })),
    );
    const relative = await cli.run({
      arguments: [
        "inspect-elf-debug-link",
        "prog",
        "--candidate-path",
        "prog.debug",
        "--json",
      ],
      cwd: root,
    });
    expect(relative.exitCode, relative.stderr).toBe(0);
    const relativeEvidence = debugLinkContract.outputSchema.parse(
      relative.json,
    );
    expect(relativeEvidence.normalized_result.verification?.status).toBe(
      "matches",
    );
    expect(relativeEvidence.subject?.local_path).toBe(imagePath);
    expect(relativeEvidence.caller_input_path).toBe("prog");
    expect(relativeEvidence.caller_input_paths).toEqual({
      candidate_path: "prog.debug",
    });
    expect(relativeEvidence.normalized_result.candidate?.path).toBe(
      candidatePath,
    );
  },
);

cliTest(
  "reports a mismatching candidate without failing the read",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-debug-link-cli-miss-");
    const imagePath = join(root, "prog");
    const candidatePath = join(root, "other.debug");
    await writeFile(
      imagePath,
      elfDebugLinkFixture({
        debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, 0x11111111, true),
      }),
    );
    await writeFile(
      candidatePath,
      elfDebugCandidateFixture({ buildIdHex: "dd".repeat(20) }),
    );
    const result = await cli.run({
      arguments: [
        "inspect-elf-debug-link",
        imagePath,
        "--candidate-path",
        candidatePath,
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = debugLinkContract.outputSchema.parse(result.json);
    expect(evidence.normalized_result.verification?.status).toBe(
      "does_not_match",
    );
  },
);

cliTest("reports a non-ELF file as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-elf-debug-link-cli-bad-");
  const path = join(root, "broken");
  await writeFile(path, Buffer.from("not an elf"));
  const result = await cli.run({
    arguments: ["inspect-elf-debug-link", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_elf_debug_link" },
  });
});

cliTest(
  "retains separate readable build IDs beside compressed ELF notes",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-elf-debug-link-note-storage-",
    );
    const candidatePath = join(root, "candidate.debug");
    const compressed = withElf64DirectSectionCount(
      compressedElfNoteSectionFixture(64, true, "both"),
      4,
    );
    const buildId = "a1".repeat(20);
    const program = gnuBuildIdNote(buildId);
    const section = gnuBuildIdNote(buildId);
    await writeFile(
      candidatePath,
      elfDebugCandidateFixture({ buildIdHex: buildId }),
    );
    const programOffset = compressed.length;
    const sectionOffset = programOffset + program.length;
    const mixed = Buffer.concat([compressed, program, section]);

    // Point the existing PT_NOTE at the readable program range rather than
    // its initial alias of the compressed section, which is still section 1.
    mixed.writeBigUInt64LE(BigInt(programOffset), 64 + 8);
    mixed.writeBigUInt64LE(BigInt(program.length), 64 + 32);
    mixed.writeBigUInt64LE(BigInt(program.length), 64 + 40);
    mixed.writeBigUInt64LE(4n, 64 + 48);
    // Add a readable section after the compressed section in directory order.
    const row = Number(mixed.readBigUInt64LE(40)) + 3 * 64;
    mixed.writeUInt32LE(1, row);
    mixed.writeUInt32LE(7, row + 4);
    mixed.writeBigUInt64LE(BigInt(sectionOffset), row + 24);
    mixed.writeBigUInt64LE(BigInt(section.length), row + 32);
    mixed.writeBigUInt64LE(4n, row + 48);
    const withAlias = Buffer.from(mixed);
    const compressedRow = row - 2 * 64;
    const compressedOffset = withAlias.readBigUInt64LE(compressedRow + 24);
    const compressedBytes = withAlias.readBigUInt64LE(compressedRow + 32);
    // The relocated section directory leaves this program header slot free.
    // Its range starts inside compressed storage, so it provides no note.
    const aliasHeader = 64 + 56;
    withAlias.writeUInt16LE(2, 56);
    withAlias.fill(0, aliasHeader, aliasHeader + 56);
    withAlias.writeUInt32LE(4, aliasHeader);
    withAlias.writeBigUInt64LE(compressedOffset + 4n, aliasHeader + 8);
    withAlias.writeBigUInt64LE(compressedBytes - 4n, aliasHeader + 32);
    withAlias.writeBigUInt64LE(compressedBytes - 4n, aliasHeader + 40);
    withAlias.writeBigUInt64LE(4n, aliasHeader + 48);

    for (const [name, image] of [
      ["mixed-notes", mixed],
      ["partial-alias", withAlias],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, image);
      const result = await cli.run({
        arguments: [
          "inspect-elf-debug-link",
          path,
          "--candidate-path",
          candidatePath,
          "--json",
        ],
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const report = debugLinkContract.outputSchema.parse(
        result.json,
      ).normalized_result;
      expect(report.build_id).toMatchObject({
        status: "unknown",
        reason: "note_tables_unsupported",
        hex: null,
        ids: [buildId],
        sources: [
          {
            hex: buildId,
            table_kind: "program",
            table_index: 0,
            note: { offset: programOffset, bytes: program.length },
            descriptor: { offset: programOffset + 16, bytes: 20 },
          },
          {
            hex: buildId,
            table_kind: "section",
            table_index: 3,
            note: { offset: sectionOffset, bytes: section.length },
            descriptor: { offset: sectionOffset + 16, bytes: 20 },
          },
        ],
      });
      expect(report.coverage.status).toBe("partial");
      expect(report.lookup_paths.some(({ kind }) => kind === "build_id")).toBe(
        false,
      );
      expect(report.verification).toMatchObject({
        status: "cannot_verify",
        build_id: {
          status: "unavailable",
          reason: "binary_build_id_unknown",
          binary_hex: null,
          candidate_hex: buildId,
        },
      });
    }
  },
);
