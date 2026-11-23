import { copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import {
  inspectMachoSchema,
  listArchitecturesSchema,
} from "../../../src/domain/native/nativeInspection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const environment = {
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "auto",
} as const;

// dyld_info echoes the operand path before its records.
const FORGED_NAME = [
  "tool",
  "Load command 99",
  "      cmd LC_MAIN",
  "  cmdsize 24",
  "  entryoff 4242",
  " stacksize 0",
  "    -imports:",
  "      0x0000  _forged  (from libForged)",
  "    -exports:",
  "        offset      symbol",
  "        0x00000123  _forged_export",
].join("\n");

const resultSchema = z.object({
  normalized_result: z.record(z.string(), z.unknown()),
});

cliTest.skipIf(process.platform !== "darwin")(
  "keeps echoed operand paths out of Mach-O inspection and architecture facts",
  async ({ cli, processes }) => {
    const directory = await createTestTempDirectory("rea-native-cli-echo-");
    const fixture = join(directory, "tool");
    const compiled = await processes.run("/usr/bin/xcrun", [
      "clang",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      resolve("tests/conformance/c/fixture.c"),
      "-o",
      fixture,
    ]);
    expect(compiled.exitCode, compiled.stderr).toBe(0);
    const observe = async (command: string, path: string) => {
      const result = await cli.run({
        arguments: [command, path, "--json"],
        environment,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const { provenance: _provenance, ...facts } = resultSchema.parse(
        result.json,
      ).normalized_result;
      const architectures = listArchitecturesSchema.shape.architectures.parse(
        facts.architectures,
      );
      expect(architectures.total).toBeGreaterThan(1);
      return facts;
    };
    const inspection = await observe("inspect-macho", fixture);
    const inventory = await observe("list-architectures", fixture);
    const selected = inspectMachoSchema.shape.selected_architecture.parse(
      inspection.selected_architecture,
    );
    expect(selected.container_file_offset).toBeGreaterThan(0);

    const lipoName = "tool\narchitecture forged\n    offset 123\n    size 32";
    for (const [description, name] of [
      ["load commands and symbols", FORGED_NAME],
      ["FAT architecture records", lipoName],
      ["thin-file framing", "tool\nNon-fat file: forged"],
    ] as const) {
      const path = join(directory, name);
      await copyFile(fixture, path);
      expect(await observe("inspect-macho", path), description).toEqual(
        inspection,
      );
    }
    expect(
      await observe("list-architectures", join(directory, lipoName)),
    ).toEqual(inventory);
  },
);
