import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { buildGamecubeDol } from "../../../src/domain/gamecubeDol.fixture.js";

cliTest(
  "validates GameCube format and architecture selections",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dol-cli-");
    const path = join(root, "image.dol");
    await writeFile(path, buildGamecubeDol());
    const result = await cli.run({
      arguments: [
        "inspect",
        path,
        "--target-format",
        "gamecube-dol",
        "--architecture",
        "arm64",
        "--json",
      ],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(result.exitCode).toBe(1);
    // open_binary's pairing rule refuses before the target is opened.
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "binary_overview",
        issues: [
          expect.objectContaining({
            path: ["architecture"],
            message: expect.stringMatching(
              /gamecube-dol.*architecture.*DOL header/iu,
            ),
          }),
        ],
      },
    });
    const invalid = await cli.run({
      arguments: ["inspect", path, "--target-format", "gamecube", "--json"],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_value",
          path: "target-format",
        }),
      ]),
    });
  },
);

cliTest(
  "rejects a headerless image until architecture and entry are supplied",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-raw-cli-");
    const path = join(root, "ecu.bin");
    await writeFile(path, Buffer.from("1eff2fe1", "hex"));
    const before = await cli.run({
      arguments: ["inspect", path, "--json"],
      environment: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
      },
    });
    expect(before.exitCode).not.toBe(0);
    expect(JSON.stringify(before.json)).not.toContain("raw-binary");
    const missing = await cli.run({
      arguments: ["inspect", path, "--target-format", "raw-binary", "--json"],
      environment: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
      },
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          expect.objectContaining({
            path: ["architecture"],
            message: expect.stringContaining("architecture"),
          }),
        ],
      },
    });
  },
);

cliTest(
  "rejects a 6502 image crossing the 16-bit boundary before provider startup",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-6502-cli-overflow-");
    const path = join(root, "image.bin");
    await writeFile(path, Buffer.from("a92a60", "hex"));
    const result = await cli.run({
      arguments: [
        "inspect",
        path,
        "--target-format",
        "raw-binary",
        "--architecture",
        "6502",
        "--entry-point",
        "0xffff",
        "--provider",
        "ghidra",
        "--json",
      ],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        reason: expect.stringContaining("6502 address width"),
        related_parameters: ["format", "architecture", "entry_point"],
        related_cli_flags: {
          format: "--target-format",
          architecture: "--architecture",
          entry_point: "--entry-point",
        },
      },
    });
  },
);

cliTest.for([
  ["arm64", "c0035fd6", "0x8000001", "must be 4-byte aligned"],
  ["m68k", "4e75", "0x1001", "must be 2-byte aligned"],
] as const)(
  "rejects an unaligned %s entry before provider startup",
  async ([architecture, bytes, entryPoint, reason], { cli }) => {
    const root = await createTestTempDirectory("rea-raw-cli-alignment-");
    const path = join(root, "image.bin");
    await writeFile(path, Buffer.from(bytes, "hex"));
    const result = await cli.run({
      arguments: [
        "analyze",
        path,
        "--target-format",
        "raw-binary",
        "--architecture",
        architecture,
        "--entry-point",
        entryPoint,
        "--provider",
        "ghidra",
        "--json",
      ],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        reason: expect.stringContaining(reason),
        related_cli_flags: {
          format: "--target-format",
          architecture: "--architecture",
          entry_point: "--entry-point",
        },
      },
    });
  },
);

cliTest(
  "stops Hopper from claiming a caller-supplied raw-binary image",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-raw-cli-hopper-");
    const path = join(root, "ecu.bin");
    await writeFile(path, Buffer.from("1eff2fe1", "hex"));
    const result = await cli.run({
      arguments: [
        "inspect",
        path,
        "--target-format",
        "raw-binary",
        "--architecture",
        "arm",
        "--entry-point",
        "0x8000000",
        "--provider",
        "hopper",
        "--json",
      ],
      environment: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result.json)).toMatch(/Hopper|ghidra|Ghidra|hopper/i);
    expect(JSON.stringify(result.json)).not.toMatch(
      /unsupported binary format/i,
    );
  },
);

cliTest(
  "renders related_cli_commands across registrars when target opening directs to another lane",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-open-related-cli-");
    const env = { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root };

    const wasmPath = join(root, "module.wasm");
    await writeFile(wasmPath, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const wasm = await cli.run({
      arguments: ["inspect", wasmPath, "--json"],
      environment: env,
    });
    expect(wasm.exitCode).toBe(1);
    expect(wasm.json).toMatchObject({
      code: "target_unavailable",
      details: {
        constraint: "wasm_requires_static_inspection",
        related_operations: ["inspect_wasm_artifact"],
        related_cli_commands: {
          inspect_wasm_artifact: "rea inspect-wasm-artifact",
        },
      },
    });

    const plainDirectory = join(root, "plain-js-dir");
    await mkdir(plainDirectory);
    const directory = await cli.run({
      arguments: ["inspect", plainDirectory, "--json"],
      environment: env,
    });
    expect(directory.exitCode).toBe(1);
    expect(directory.json).toMatchObject({
      code: "target_unavailable",
      details: {
        constraint: "directory_requires_file",
        related_operations: [
          "inspect_desktop_application",
          "audit_release_exposure",
          "analyze_javascript_application",
        ],
        related_cli_commands: {
          inspect_desktop_application: "rea inspect-desktop-application",
          audit_release_exposure: "rea audit-release-exposure",
          analyze_javascript_application: "rea analyze-javascript-application",
        },
      },
    });

    const bundle = join(root, "Codeless.app", "Contents");
    await mkdir(bundle, { recursive: true });
    await writeFile(
      join(bundle, "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>',
    );
    const missingExec = await cli.run({
      arguments: ["inspect", join(root, "Codeless.app"), "--json"],
      environment: env,
    });
    expect(missingExec.exitCode).toBe(1);
    expect(missingExec.json).toMatchObject({
      code: "target_unavailable",
      details: {
        constraint: "bundle_executable_undeclared",
        related_operations: ["inspect_plist"],
        related_cli_commands: {
          inspect_plist: "rea inspect-plist",
        },
      },
    });
  },
);
