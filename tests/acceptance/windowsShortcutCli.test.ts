import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import {
  powershellHiddenIconSpoofShortcut,
  truncatedStringDataShortcut,
  wrongClsidShortcut,
  windowsShortcutBytes,
} from "../fixtures/binaryDiagnostics/windowsShortcut.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const shortcutContract = (() => {
  const contract = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
    (item) => item.name === "inspect_windows_shortcut",
  );
  if (contract === undefined)
    throw new Error("Missing inspect_windows_shortcut contract");
  return contract;
})();

cliTest.for([
  { target: "C:\\Tools\\\x83A.exe", icon: "C:\\Tools\\\x83a.exe" },
  { target: "C:\\Tools\\\x82\x60.exe", icon: "C:\\Tools\\\x82\x81.exe" },
])(
  "preserves opaque ANSI path facts through compiled CLI and stdio MCP: $target",
  async ({ target, icon }, { cli }) => {
    const root = await createTestTempDirectory("rea-shortcut-ansi-cli-");
    const path = join(root, "shortcut.lnk");
    const bytes = windowsShortcutBytes({
      unicode: false,
      idList: null,
      relativePath: "",
      linkInfo: { localBasePath: target },
      extraData: [],
      iconLocation: icon,
    });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-windows-shortcut", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_windows_shortcut", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    for (const value of [result.json, response.structuredContent]) {
      const evidence = shortcutContract.outputSchema.parse(value);
      const report = evidence.normalized_result;
      expect(report.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(report.link_info?.local_base_path).toBe(target);
      expect(report.string_data.icon_location?.value).toBe(icon);
      expect(report.coverage.status).toBe("complete");
      expect(report.observations).toEqual(
        expect.arrayContaining([
          {
            kind: "icon_location_differs_from_target",
            evidence_kind: "derived",
            value: null,
          },
          {
            kind: "target_extension",
            evidence_kind: "derived",
            extension: ".exe",
          },
        ]),
      );
    }
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "reports Shell Link facts through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-windows-shortcut-cli-");
    const path = join(root, "shortcut.lnk");
    await writeFile(path, powershellHiddenIconSpoofShortcut());
    const result = await cli.run({
      arguments: ["inspect-windows-shortcut", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = shortcutContract.outputSchema.parse(result.json);
    expect(evidence.normalized_result.header.show_command.decoded).toBe(
      "minimized",
    );
    expect(evidence.normalized_result.string_data.arguments?.value).toContain(
      "-WindowStyle Hidden",
    );
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected a stdio MCP session");
    const mcp = await call("inspect_windows_shortcut", { path });
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
    const mcpEvidence = shortcutContract.outputSchema.parse(
      mcp.structuredContent,
    );
    expect(mcpEvidence.normalized_result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "icon_location_differs_from_target",
          value: true,
        }),
      ]),
    );
  },
);

cliTest(
  "resolves a relative Shell Link path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-windows-shortcut-cli-rel-");
    await writeFile(
      join(root, "shortcut.lnk"),
      powershellHiddenIconSpoofShortcut(),
    );
    const result = await cli.run({
      arguments: ["inspect-windows-shortcut", "shortcut.lnk", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = shortcutContract.outputSchema.parse(result.json);
    expect(evidence.subject?.local_path).toBe(join(root, "shortcut.lnk"));
  },
);

cliTest("reports a wrong CLSID as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-windows-shortcut-cli-bad-");
  const path = join(root, "broken.lnk");
  await writeFile(path, wrongClsidShortcut());
  const result = await cli.run({
    arguments: ["inspect-windows-shortcut", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_windows_shortcut" },
  });
});

cliTest(
  "keeps truncated StringData as a partial inventory",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-windows-shortcut-cli-trunc-",
    );
    const path = join(root, "truncated.lnk");
    await writeFile(path, truncatedStringDataShortcut());
    const result = await cli.run({
      arguments: ["inspect-windows-shortcut", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = shortcutContract.outputSchema.parse(
      result.json,
    ).normalized_result;
    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.failing_offset).toEqual(expect.any(Number));
  },
);
