import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";
import { REVERSE_ENGINEERING_TOOL_CONTRACTS } from "../../../src/contracts/reverseEngineeringToolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reports missing and directory objdump inputs with structured reasons",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-objdump-invalid-target-");
    const missing = join(root, "missing.bin");
    const directory = root;

    for (const [path, expectedReason] of [
      [missing, "not found"],
      [directory, "not a regular file"],
    ] as const) {
      const result = await cli.run({
        arguments: [
          "inspect-with-objdump",
          path,
          "symbols",
          "--format",
          "json",
        ],
        cwd: root,
      });
      expect(result.exitCode).toBe(1);
      expect(analysisErrorProjectionSchema.safeParse(result.json).success).toBe(
        true,
      );
      expect(result.json).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        retryable: false,
        message: expect.stringContaining(path),
        details: {
          operation: "inspect_with_objdump",
          issues: [
            {
              path: ["path"],
              reason: "invalid_value",
              message: expect.stringContaining(expectedReason),
            },
          ],
        },
      });
    }
  },
);

cliTest(
  "passes Rizin decoder and map flags before the artifact",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rizin-load-flags-");
    const provider = join(root, "argv-rizin");
    const artifact = join(root, "flash.bin");
    await writeFile(artifact, "flash");
    await writeFile(
      provider,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
    );
    await chmod(provider, 0o755);
    const result = await cli.run({
      arguments: [
        "execute-rizin-command",
        artifact,
        "oml",
        "--asm-arch",
        "riscv",
        "--asm-bits",
        "32",
        "--asm-cpu",
        "rv32imc",
        "--base-address",
        "0x42000000",
        "--format",
        "json",
      ],
      cwd: root,
      environment: { REA_RIZIN_COMMAND: provider },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const rizinContract = REVERSE_ENGINEERING_TOOL_CONTRACTS.find(
      (contract) => contract.name === "execute_rizin_command",
    );
    if (rizinContract === undefined)
      throw new Error("execute_rizin_command contract is missing");
    const evidence = rizinContract.outputSchema.parse(result.json);
    const argv = [
      "-N",
      "-q",
      "-e",
      "scr.color=0",
      "-a",
      "riscv",
      "-b",
      "32",
      "-e",
      "asm.cpu=rv32imc",
      "-n",
      "-m",
      "0x42000000",
      "-c",
      "oml",
      artifact,
    ];
    expect(JSON.parse(evidence.normalized_result.stdout)).toEqual(argv);
    expect(evidence.parameters).toMatchObject({
      asm_arch: "riscv",
      asm_bits: 32,
      asm_cpu: "rv32imc",
      base_address: "0x42000000",
      command_arguments: argv,
    });
  },
);

cliTest(
  "reports the rejected Rizin command before inspecting the target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rizin-invalid-command-");
    const result = await cli.run({
      arguments: [
        "execute-rizin-command",
        join(root, "unopened.bin"),
        "iI\nq",
        "--format",
        "json",
      ],
      cwd: root,
    });
    expect(result.exitCode).toBe(1);
    expect(analysisErrorProjectionSchema.parse(result.json)).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "execute_rizin_command",
        issues: [
          {
            path: ["command"],
            reason: "invalid_value",
            message: "A single command line is required",
          },
        ],
      },
    });
  },
);

cliTest(
  "rejects a Rizin width that no arch plugin declares",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rizin-invalid-bits-");
    const artifact = join(root, "flash.bin");
    await writeFile(artifact, "flash");
    const result = await cli.run({
      arguments: [
        "execute-rizin-command",
        artifact,
        "e asm.bits",
        "--asm-arch",
        "arm",
        "--asm-bits",
        "17",
        "--format",
        "json",
      ],
      cwd: root,
      environment: { REA_RIZIN_COMMAND: join(root, "no-rizin") },
    });
    // Rizin would apply 17 on ARM and decode as ARM32. REA rejects it before
    // it looks for Rizin.
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({
          path: "asmBits",
          message: "Expected one of 4, 8, 16, 32, 64",
        }),
      ],
    });
  },
);
