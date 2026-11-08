import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  elfHardeningFixture,
  peHardeningImage,
} from "../../src/native/hardening/BinaryHardening.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
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
    const elfBytes = elfHardeningFixture({ interp: true, gnuRelro: true });
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
    expect(parseMcpToolError(response)).toEqual({ error: rejected.json });
  },
  60_000,
);
