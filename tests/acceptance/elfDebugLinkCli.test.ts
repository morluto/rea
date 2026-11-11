import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  gnuDebuglinkCrc32,
  gnuDebuglinkCrc32Hex,
} from "../../src/native/elf/ElfDebugLink.js";
import {
  debuglinkSection,
  elfDebugCandidateFixture,
  elfDebugLinkFixture,
  FIXTURE_BUILD_ID_HEX,
  FIXTURE_DEBUG_NAME,
} from "../../src/native/elf/ElfDebugLink.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "verifies a matching debug file from absolute and relative paths",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-debug-link-cli-");
    const candidate = elfDebugCandidateFixture();
    const image = elfDebugLinkFixture({
      debuglink: debuglinkSection(
        FIXTURE_DEBUG_NAME,
        gnuDebuglinkCrc32(candidate),
        true,
      ),
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
    const evidence = toolContract("inspect_elf_debug_link").outputSchema.parse(
      absolute.json,
    );
    expect(evidence.normalized_result.verification?.status).toBe("matches");
    expect(evidence.normalized_result.candidate).toMatchObject({
      debug_info: "present",
      symtab: "present",
    });
    expect(evidence.normalized_result.debuglink.crc32_hex).toBe(
      gnuDebuglinkCrc32Hex(candidate),
    );
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
    const relativeEvidence = toolContract(
      "inspect_elf_debug_link",
    ).outputSchema.parse(relative.json);
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
    const evidence = toolContract("inspect_elf_debug_link").outputSchema.parse(
      result.json,
    );
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
