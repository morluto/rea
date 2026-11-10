import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { interfaceBuilderAnalysisSchema } from "../../../src/domain/apple/interfaceBuilderGraph.js";
import { keyedArchiveResultSchema } from "../../../src/domain/apple/keyedArchive.js";
import { inspectPlistSchema } from "../../../src/domain/native/nativeInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for([
  "decode_interface_builder",
  "inspect_keyed_archive",
  ...(process.platform === "darwin"
    ? ["inspect_asset_catalog", "inspect_plist"]
    : []),
] as const)(
  "binds live %s Evidence to the open executable through stdio MCP",
  async (operation) => {
    const root = await createTestTempDirectory("rea-bundle-resource-identity-");
    const app = join(root, "Probe.app");
    const contents = join(app, "Contents");
    const resources = join(contents, "Resources");
    await mkdir(resources, { recursive: true });
    await mkdir(join(contents, "MacOS"));
    const executable = join(contents, "MacOS", "Probe");
    const original = thinMach(0xfeedfacf, 0x0100000c);
    await writeFile(executable, original);
    const initialPlist =
      "<plist><dict><key>CFBundleExecutable</key><string>Probe</string></dict></plist>";
    const changedPlist =
      "<plist><dict><key>CFBundleExecutable</key><string>Probe</string><key>Marker</key><string>ChangedController</string></dict></plist>";
    await writeFile(join(contents, "Info.plist"), initialPlist);
    const nib = await readFile(
      join(process.cwd(), "tests/fixtures/interface-builder/UIKitOutlet.xml"),
      "utf8",
    );
    const nibPath = join(resources, "Main.nib");
    await writeFile(nibPath, nib);
    const { call } = await connectLocalToolsMcp();
    const parameters =
      operation === "inspect_keyed_archive"
        ? { path: "Contents/Resources/Main.nib" }
        : {};
    expect((await call("open_binary", { path: app })).isError).not.toBe(true);
    const before = await call(operation, parameters);
    expect(before.isError).not.toBe(true);
    const initial = parseEvidence(before.structuredContent);
    // inspect_plist reports the plist file it read, not the open executable.
    if (operation === "inspect_plist") {
      expect(initial.subject?.format).toBe("plist");
      expect(initial.subject?.digest.sha256).toBe(
        createHash("sha256").update(initialPlist).digest("hex"),
      );
    } else
      expect(initial.subject?.digest.sha256).toBe(
        createHash("sha256").update(original).digest("hex"),
      );

    const changed = Buffer.from(original);
    changed[31] = 1;
    await writeFile(executable, changed);
    const changedNib = nib.replaceAll("UIViewController", "ChangedController");
    expect(changedNib).not.toBe(nib);
    await writeFile(nibPath, changedNib);
    if (operation === "inspect_plist")
      await writeFile(join(contents, "Info.plist"), changedPlist);
    const stale = await call(operation, parameters);
    expect(parseMcpToolError(stale).error).toMatchObject({
      code:
        operation === "inspect_plist"
          ? "artifact_changed"
          : "artifact_operation_failed",
      category: "integrity_mismatch",
    });

    expect((await call("open_binary", { path: app })).isError).not.toBe(true);
    const after = await call(operation, parameters);
    expect(after.isError).not.toBe(true);
    const refreshed = parseEvidence(after.structuredContent);
    if (operation === "inspect_plist") {
      expect(refreshed.subject?.format).toBe("plist");
      expect(refreshed.subject?.digest.sha256).toBe(
        createHash("sha256").update(changedPlist).digest("hex"),
      );
    } else
      expect(refreshed.subject?.digest.sha256).toBe(
        createHash("sha256").update(changed).digest("hex"),
      );
    const nibHash = createHash("sha256").update(changedNib).digest("hex");
    if (operation === "inspect_plist")
      expect(
        inspectPlistSchema.parse(refreshed.normalized_result).value,
      ).toMatchObject({ Marker: "ChangedController" });
    if (operation === "decode_interface_builder") {
      const report = interfaceBuilderAnalysisSchema.parse(
        refreshed.normalized_result,
      );
      expect(report.documents).toContainEqual(
        expect.objectContaining({
          relative_path: "Contents/Resources/Main.nib",
          archive_sha256: nibHash,
        }),
      );
      expect(report.graph.nodes).toContainEqual(
        expect.objectContaining({
          attributes: expect.objectContaining({
            class_name: "ChangedController",
          }),
        }),
      );
    }
    if (operation === "inspect_keyed_archive") {
      const report = keyedArchiveResultSchema.parse(
        refreshed.normalized_result,
      );
      expect(report.archive_sha256).toBe(nibHash);
      expect(report.objects).toContainEqual(
        expect.objectContaining({ class_name: "ChangedController" }),
      );
    }
  },
);
