import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import {
  powershellHiddenIconSpoofShortcut,
  TRACKER_MAC,
  truncatedStringDataShortcut,
  uuidV1Bytes,
  windowsShortcutBytes,
  wrongClsidShortcut,
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
  "preserves unreadable environment target uncertainty through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-shortcut-environment-cli-");
    const iconLocation = "C:\\Tools\\icon.exe";
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected a stdio MCP session");
    for (const {
      kind,
      localBasePath,
      expectedDifference,
      expectedExtension,
    } of [
      {
        kind: "environment",
        localBasePath: "C:\\Tools\\other.dll",
        expectedDifference: null,
        expectedExtension: null,
      },
      {
        kind: "environment",
        localBasePath: iconLocation,
        expectedDifference: false,
        expectedExtension: null,
      },
      {
        kind: "icon_environment",
        localBasePath: "C:\\Tools\\other.dll",
        expectedDifference: true,
        expectedExtension: ".dll",
      },
    ] as const) {
      const valid = windowsShortcutBytes({
        idList: null,
        relativePath: "",
        linkInfo: { localBasePath },
        iconLocation,
        extraData: [{ kind, unicode: iconLocation }],
      });
      const terminal = valid.length - 4;
      const blockOffset = terminal - 0x314;
      const tail = Buffer.from([0xab, 0xcd]);
      const bytes = Buffer.concat([
        valid.subarray(0, terminal),
        tail,
        valid.subarray(terminal),
      ]);
      bytes.writeUInt32LE(0x314 + tail.length, blockOffset);
      const path = join(root, `${kind}-${String(expectedDifference)}.lnk`);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-windows-shortcut", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const response = await call("inspect_windows_shortcut", { path });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      for (const value of [result.json, response.structuredContent]) {
        const { normalized_result: report } =
          shortcutContract.outputSchema.parse(value);
        expect(report.coverage).toMatchObject({
          status: "partial",
          failing_offset: blockOffset,
        });
        expect(report.extra_data.blocks[0]?.decoded.kind).toBe("raw");
        expect(report.observations).toEqual(
          expect.arrayContaining([
            {
              kind: "icon_location_differs_from_target",
              evidence_kind: "derived",
              value: expectedDifference,
            },
            {
              kind: "target_extension",
              evidence_kind: "derived",
              extension: expectedExtension,
            },
          ]),
        );
      }
    }
  },
);

cliTest(
  "preserves pre-epoch shortcut timestamps through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-shortcut-time-cli-");
    const path = join(root, "time.lnk");
    const uuid = uuidV1Bytes(122192927999999999n, 1, TRACKER_MAC);
    await writeFile(
      path,
      windowsShortcutBytes({
        creationTime: 116444735999999999n,
        accessTime: 0n,
        writeTime: 116444736000000001n,
        extraData: [
          { kind: "tracker", droid: [uuid, uuid], birthDroid: [uuid, uuid] },
        ],
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-windows-shortcut", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected a stdio MCP session");
    const response = await call("inspect_windows_shortcut", { path });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    for (const value of [result.json, response.structuredContent]) {
      const evidence = shortcutContract.outputSchema.parse(value);
      const report = evidence.normalized_result;
      expect(evidence.subject?.local_path).toBe(path);
      expect(report.header).toMatchObject({
        creation_time: {
          raw: "116444735999999999",
          iso8601: "1969-12-31T23:59:59.999Z",
        },
        access_time: { raw: "0", iso8601: null },
        write_time: {
          raw: "116444736000000001",
          iso8601: "1970-01-01T00:00:00.000Z",
        },
      });
      const tracker = report.extra_data.blocks[0]?.decoded;
      if (tracker?.kind !== "tracker")
        throw new Error("Expected TrackerDataBlock");
      for (const time of [
        ...tracker.droid_uuid_v1,
        ...tracker.birth_droid_uuid_v1,
      ])
        expect(time).toMatchObject({
          timestamp_100ns: "122192927999999999",
          timestamp_iso8601: "1969-12-31T23:59:59.999Z",
        });
      expect(report.coverage.status).toBe("complete");
    }
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
