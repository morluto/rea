import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { desktopApplicationSchema } from "../../../src/domain/desktopApplication.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/** A complete PE image whose CLI directory is cleared: a native Windows image. */
const nativePe = (): Buffer => {
  const bytes = buildManagedPeFixture({ references: [] });
  const optional = bytes.readUInt32LE(0x3c) + 24;
  const directories =
    optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96);
  bytes.fill(0, directories + 14 * 8, directories + 15 * 8);
  return bytes;
};

cliTest(
  "recognises a native SDL release the same way over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-desktop-native-cli-");
    for (const [path, bytes] of [
      ["PPSSPPWindows64.exe", nativePe()],
      ["SDL2.dll", nativePe()],
      ["assets/ui_atlas.zim", "atlas"],
    ] as const) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), bytes);
    }
    const result = await cli.run({
      arguments: ["inspect-desktop-application", root, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = desktopApplicationSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
    const pathOf = new Map(
      report.files.map((file) => [file.file_id, file.path]),
    );
    expect(report.candidates.map(({ family }) => family)).toEqual(["native"]);
    expect(report.components.map(({ name }) => name)).toEqual(["SDL"]);
    expect(
      report.next_probes.map(({ operation, file_id }) => [
        operation,
        pathOf.get(file_id),
      ]),
    ).toEqual([
      ["inspect_pe_imports", "PPSSPPWindows64.exe"],
      ["inspect_pe_resources", "PPSSPPWindows64.exe"],
    ]);

    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_desktop_application", {
      path: root,
      detail: "complete",
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const mcp = desktopApplicationSchema.parse(
      parseEvidence(response.structuredContent).normalized_result,
    );
    expect({
      candidates: mcp.candidates,
      components: mcp.components,
      next_probes: mcp.next_probes,
      deferred_probes: mcp.deferred_probes,
    }).toEqual({
      candidates: report.candidates,
      components: report.components,
      next_probes: report.next_probes,
      deferred_probes: report.deferred_probes,
    });
  },
);
