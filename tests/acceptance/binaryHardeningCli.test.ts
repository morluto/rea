import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  elfHardeningFixture,
  peHardeningImage,
} from "../../src/native/hardening/BinaryHardening.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  expectAdapterErrorParity,
  parseMcpToolError,
} from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

const states = (
  rows: readonly { property: string; state: string }[],
): Record<string, string> =>
  Object.fromEntries(rows.map((row) => [row.property, row.state]));

cliTest(
  "reads ELF and PE hardening through the CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-binary-hardening-cli-");
    const call = await cli.sharedMcpCall!();
    const elfPath = join(root, "app");
    const elfBytes = elfHardeningFixture({
      interp: true,
      gnuRelro: true,
      compressedPropertyNote: true,
      property: { arch: "x86", value: 3 },
    });
    await writeFile(elfPath, elfBytes);
    const elfResult = await cli.run({
      arguments: ["inspect-binary-hardening", "app", "--json"],
      cwd: root,
    });
    expect(elfResult.exitCode, elfResult.stderr).toBe(0);
    const elfResponse = await call("inspect_binary_hardening", {
      path: elfPath,
    });
    expect(elfResponse.isError).not.toBe(true);
    for (const value of [elfResult.json, elfResponse.structuredContent]) {
      const report = toolContract(
        "inspect_binary_hardening",
      ).outputSchema.parse(value).normalized_result;
      expect(report.format).toBe("elf");
      expect(states(report.images[0]?.rows ?? [])).toMatchObject({
        pie: "enabled",
        nx: "enabled",
        relro: "partial",
        stack_protector: "unknown",
        cet_ibt_shstk: "unknown",
      });
    }
    expect(
      toolContract("inspect_binary_hardening").outputSchema.parse(
        elfResult.json,
      ).subject,
    ).toMatchObject({ local_path: elfPath });
    expect((await readFile(elfPath)).equals(elfBytes)).toBe(true);

    const pePath = join(root, "app.exe");
    const peBytes = peHardeningImage();
    await writeFile(pePath, peBytes);
    const peResult = await cli.run({
      arguments: ["inspect-binary-hardening", pePath, "--json"],
    });
    expect(peResult.exitCode, peResult.stderr).toBe(0);
    const peReport = toolContract(
      "inspect_binary_hardening",
    ).outputSchema.parse(peResult.json).normalized_result;
    expect(states(peReport.images[0]?.rows ?? [])).toMatchObject({
      dynamic_base: "enabled",
      nx_compat: "enabled",
      guard_cf: "enabled",
      cfg_instrumented: "enabled",
      authenticode_present: "disabled",
    });
    expect((await readFile(pePath)).equals(peBytes)).toBe(true);

    const foreign = join(root, "notes.txt");
    await writeFile(foreign, Buffer.from("not a binary"));
    const rejected = await cli.run({
      arguments: ["inspect-binary-hardening", foreign, "--json"],
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.json).toMatchObject({
      details: { operation: "inspect_binary_hardening" },
    });
    const response = await call("inspect_binary_hardening", { path: foreign });
    expect(response.isError).toBe(true);
    expectAdapterErrorParity(
      parseMcpToolError(response).error,
      rejected.json,
      "inspect_binary_hardening",
    );
  },
);

cliTest(
  "reports structured max_table_entries details.limit through CLI and MCP and accepts raised budget",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-hardening-table-limit-");
    const path = join(root, "wide-dynamic");
    const fixture = elfHardeningFixture();
    const bytes = Buffer.concat([fixture, Buffer.alloc(65_537 * 16)]);
    const programs = Number(bytes.readBigUInt64LE(32));
    const dynamic = Array.from(
      { length: bytes.readUInt16LE(56) },
      (_, index) => programs + index * bytes.readUInt16LE(54),
    ).find((at) => bytes.readUInt32LE(at) === 2);
    if (dynamic === undefined) throw new Error("Fixture has no PT_DYNAMIC");
    bytes.writeBigUInt64LE(BigInt(fixture.length), dynamic + 8);
    bytes.writeBigUInt64LE(65_537n * 16n, dynamic + 32);
    await writeFile(path, bytes);

    const call = await cli.sharedMcpCall!();
    const expected = {
      code: "resource_constraint",
      details: {
        operation: "inspect_binary_hardening",
        resource: "capacity",
        limit: {
          control_kind: "parameter",
          parameter: "max_table_entries",
          effective_value: 65_536,
          required_value: 65_537,
          minimum: 1,
          maximum: 1_048_576,
          default_value: 65_536,
          unit: "count",
          applies_at: "next_call",
        },
      },
    };
    const rejectedCli = await cli.run({
      arguments: ["inspect-binary-hardening", path, "--json"],
    });
    expect(rejectedCli.exitCode, rejectedCli.stderr).toBe(1);
    expect(rejectedCli.json).toMatchObject({
      ...expected,
      details: {
        ...expected.details,
        limit: {
          ...expected.details.limit,
          cli_flag: "--max-table-entries",
        },
      },
    });
    const rejectedMcp = await call("inspect_binary_hardening", { path });
    expect(rejectedMcp.isError).toBe(true);
    const mcpError = parseMcpToolError(rejectedMcp).error;
    expect(mcpError).toMatchObject({
      ...expected,
      details: {
        ...expected.details,
        refusal: {
          kind: "adjustable_budget",
          control: "max_table_entries",
        },
      },
    });
    expect(mcpError.details?.limit).not.toHaveProperty("cli_flag");

    const raisedCli = await cli.run({
      arguments: [
        "inspect-binary-hardening",
        path,
        "--max-table-entries",
        "65537",
        "--json",
      ],
    });
    expect(raisedCli.exitCode, raisedCli.stderr).toBe(0);
    const raisedMcp = await call("inspect_binary_hardening", {
      path,
      max_table_entries: 65_537,
    });
    expect(raisedMcp.isError).not.toBe(true);
  },
);
