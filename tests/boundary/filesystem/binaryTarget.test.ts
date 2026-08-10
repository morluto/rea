import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/domain/binaryTarget.js";
import { pe, thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("binary target I/O", () => {
  it("classifies ZIP package families and text artifacts without Hopper", async () => {
    const directory = await createTestTempDirectory("rea-artifact-target-");
    const zip = join(directory, "fixture.apk");
    const msix = join(directory, "fixture.msixbundle");
    const appx = join(directory, "fixture.appx");
    const script = join(directory, "bundle.js");
    const emptyZip = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
    await Promise.all([
      writeFile(zip, emptyZip),
      writeFile(msix, emptyZip),
      writeFile(appx, emptyZip),
    ]);
    await writeFile(script, "export default 1;\n");
    const archive = await parseBinaryTarget(zip);
    const msixArchive = await parseBinaryTarget(msix);
    const appxArchive = await parseBinaryTarget(appx);
    const javascript = await parseBinaryTarget(script);
    expect(archive.ok && archive.value).toMatchObject({
      kind: "archive",
      format: "apk",
    });
    expect(msixArchive.ok && msixArchive.value).toMatchObject({
      kind: "archive",
      format: "msix",
    });
    expect(appxArchive.ok && appxArchive.value).toMatchObject({
      kind: "archive",
      format: "appx",
    });
    expect(javascript.ok && javascript.value).toMatchObject({
      kind: "artifact",
      format: "javascript",
    });
  });

  it("does not trust a ZIP-family extension without ZIP magic", async () => {
    const directory = await createTestTempDirectory("rea-fake-archive-");
    const path = join(directory, "fake.zip");
    await writeFile(path, "not a zip");
    const result = await parseBinaryTarget(path);
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "BinaryTargetError" },
    });
  });

  it("resolves relative Hopper databases and rejects unknown or unreadable paths", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    await writeFile(join(directory, "sample.hop"), "database");
    await writeFile(join(directory, "text"), "hello");
    const database = await parseBinaryTarget("sample.hop", directory);
    expect(database.ok && database.value.sha256).toBe(
      "3549b0028b75d981cdda2e573e9cb49dedc200185876df299f912b79f69dabd8",
    );
    expect((await parseBinaryTarget("text", directory)).ok).toBe(false);
    expect((await parseBinaryTarget("missing", directory)).ok).toBe(false);
  });

  it("rejects non-regular targets before reading them", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    expect((await parseBinaryTarget(directory)).ok).toBe(false);
  });

  it("resolves a macOS app bundle to its declared program file", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    const app = join(directory, "Example App.app");
    const contents = join(app, "Contents");
    const programs = join(contents, "MacOS");
    await mkdir(programs, { recursive: true });
    await writeFile(
      join(contents, "Info.plist"),
      '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>Example &amp; Tool</string></dict></plist>',
    );
    await writeFile(
      join(programs, "Example & Tool"),
      thinMach(0xfeedfacf, 0x0100000c),
    );
    const result = await parseBinaryTarget(app, directory, "arm64");
    expect(result.ok && result.value).toMatchObject({
      path: await realpath(join(programs, "Example & Tool")),
      format: "mach-o",
    });
  });

  it.each([
    ["missing plist", undefined],
    ["missing executable name", "<plist><dict></dict></plist>"],
    [
      "unsafe executable name",
      "<plist><dict><key>CFBundleExecutable</key><string>../escape</string></dict></plist>",
    ],
    [
      "missing program file",
      "<plist><dict><key>CFBundleExecutable</key><string>Missing</string></dict></plist>",
    ],
  ])("rejects an app bundle with %s", async (_case, plist) => {
    const directory = await createTestTempDirectory("rea-target-");
    const app = join(directory, "Broken.app");
    const contents = join(app, "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    if (plist !== undefined)
      await writeFile(join(contents, "Info.plist"), plist);
    expect((await parseBinaryTarget(app, directory, "arm64")).ok).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "rejects an app program symlink that leaves the bundle",
    async () => {
      const directory = await createTestTempDirectory("rea-target-");
      const app = join(directory, "Escaping.app");
      const contents = join(app, "Contents");
      const programs = join(contents, "MacOS");
      const outside = join(directory, "outside");
      await mkdir(programs, { recursive: true });
      await writeFile(outside, thinMach(0xfeedfacf, 0x0100000c));
      await writeFile(
        join(contents, "Info.plist"),
        "<plist><dict><key>CFBundleExecutable</key><string>Escaping</string></dict></plist>",
      );
      await symlink(outside, join(programs, "Escaping"));
      expect((await parseBinaryTarget(app, directory, "arm64")).ok).toBe(false);
    },
  );

  it("honors an explicit database kind without relying on the file suffix", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    await writeFile(join(directory, "saved-analysis"), "database");
    const result = await parseBinaryTarget(
      "saved-analysis",
      directory,
      "arm64",
      "database",
    );
    expect(result.ok && result.value).toMatchObject({
      kind: "database",
      format: "analysis-database",
    });
  });

  it("reads a PE header beyond the initial probe", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    const path = join(directory, "delayed.exe");
    await writeFile(path, pe(0x8664, 8192));
    const result = await parseBinaryTarget(path, directory, "x64");
    expect(result.ok && result.value).toMatchObject({
      format: "pe",
      architecture: "x86_64",
    });
  });
});
