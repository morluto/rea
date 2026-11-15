import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const machoWithUuid = () => {
  const header = thinMach(0xcffaedfe, 0x0100000c);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(24, 20);
  const lcUuid = Buffer.alloc(24);
  lcUuid.writeUInt32LE(0x1b, 0);
  lcUuid.writeUInt32LE(24, 4);
  Buffer.from("11111111222233334444555555555555", "hex").copy(lcUuid, 8);
  return Buffer.concat([header, lcUuid]);
};

cliTest(
  "rejects relative --dsym-path and headerless format pairing before opening the target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dsym-cli-validation-");
    const target = join(root, "target");
    await writeFile(target, machoWithUuid());
    const env = { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root };

    const relative = await cli.run({
      arguments: [
        "inspect",
        target,
        "--dsym-path",
        "rel/target.dSYM",
        "--provider",
        "ghidra",
        "--json",
      ],
      cwd: root,
      environment: env,
    });
    expect(relative.exitCode).not.toBe(0);
    expect(relative.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ path: "dsym-path" }),
      ]),
    });

    const paired = await cli.run({
      arguments: [
        "decompile",
        target,
        "main",
        "--target-format",
        "raw-binary",
        "--architecture",
        "arm",
        "--entry-point",
        "0x8000000",
        "--dsym-path",
        join(root, "target.dSYM"),
        "--provider",
        "ghidra",
        "--json",
      ],
      cwd: root,
      environment: env,
    });
    expect(paired.exitCode).toBe(1);
    expect(paired.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "procedure_pseudo_code",
        issues: [
          expect.objectContaining({
            path: ["dsym-path"],
            message: expect.stringContaining("detected Mach-O"),
          }),
        ],
      },
    });
  },
);

cliTest.for(["inspect", "analyze"] as const)(
  "%s forwards --dsym-path to binary target companion validation before provider startup",
  async (command, { cli }) => {
    const root = await createTestTempDirectory("rea-dsym-cli-forward-");
    const target = join(root, "target");
    const nonDsymDir = join(root, "pair-nosuffix");
    await writeFile(target, machoWithUuid());
    await mkdir(join(nonDsymDir, "Contents", "Resources", "DWARF"), {
      recursive: true,
    });
    await writeFile(
      join(nonDsymDir, "Contents", "Resources", "DWARF", "pair"),
      machoWithUuid(),
    );
    const result = await cli.run({
      arguments: [
        command,
        target,
        "--dsym-path",
        nonDsymDir,
        "--provider",
        "ghidra",
        "--json",
      ],
      cwd: root,
      environment: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        path: target,
        constraint: "debug_companion_rejected",
        reason: `dsym_path is not a .dSYM bundle directory: ${nonDsymDir}`,
        diagnostics: {
          dsym_path: nonDsymDir,
          rejection: "not_dsym_bundle",
        },
      },
    });
  },
);
