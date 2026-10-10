import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import {
  copyAnalysisProject,
  parseAnalysisProjectTarget,
} from "../../../src/application/AnalysisProjectTarget.js";
import {
  resolveAppBundleExecutable,
  type AppBundleFileSystem,
} from "../../../src/application/AppBundleExecutable.js";
import {
  dosMz,
  pe,
  thinMach,
} from "../../../src/domain/binaryTarget.fixture.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("binary target I/O: app plist permissions and decoding", () => {
  it.each([
    ["EACCES", "permission denied reading app Info.plist"],
    ["EPERM", "permission denied reading app Info.plist"],
  ])("preserves %s while reading an app plist", async (code, message) => {
    const directory = await createTestTempDirectory("rea-app-permission-");
    const app = join(directory, "Permission.app");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(join(app, "Contents", "Info.plist"), "placeholder");
    const denied = Object.assign(new Error("denied"), { code });
    const fileSystem: AppBundleFileSystem = {
      readFile: async () => {
        throw denied;
      },
      realpath,
    };
    const result = await resolveAppBundleExecutable(app, fileSystem);
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "BinaryTargetError",
        path: join(app, "Contents", "Info.plist"),
        reason: expect.stringContaining(message),
        cause: denied,
        systemCode: code,
      },
    });
  });

  it("preserves non-permission plist read failures as read failures", async () => {
    const directory = await createTestTempDirectory("rea-app-read-error-");
    const app = join(directory, "ReadError.app");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(join(app, "Contents", "Info.plist"), "placeholder");
    const readError = Object.assign(new Error("I/O failure"), { code: "EIO" });
    const result = await resolveAppBundleExecutable(app, {
      readFile: async () => {
        throw readError;
      },
      realpath,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        path: join(app, "Contents", "Info.plist"),
        reason: expect.stringContaining("could not read app Info.plist"),
        cause: readError,
      },
    });
  });

  it("does not label binary plist decoder I/O failures as malformed data", async () => {
    const directory = await createTestTempDirectory("rea-app-decode-error-");
    const app = join(directory, "DecodeError.app");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(join(app, "Contents", "Info.plist"), "bplist00");
    const decodeError = Object.assign(new Error("I/O failure"), {
      code: "EIO",
    });
    const result = await resolveAppBundleExecutable(app, {
      readFile: async () => Buffer.from("bplist00"),
      realpath,
      decodeBinaryPlist: async () => {
        throw decodeError;
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        path: join(app, "Contents", "Info.plist"),
        reason: expect.stringContaining("could not decode app Info.plist"),
        cause: decodeError,
      },
    });
  });

  it.each(["EACCES", "EPERM", "ENOENT", "ENOTDIR"])(
    "preserves %s while resolving an app executable",
    async (code) => {
      const directory = await createTestTempDirectory("rea-app-permission-");
      const app = join(directory, "Permission.app");
      const programs = join(app, "Contents", "MacOS");
      await mkdir(programs, { recursive: true });
      await writeFile(
        join(app, "Contents", "Info.plist"),
        "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
      );
      const denied = Object.assign(new Error("denied"), { code });
      const fileSystem: AppBundleFileSystem = {
        readFile,
        realpath: async (path) => {
          if (String(path) === join(programs, "App")) throw denied;
          return realpath(path);
        },
      };
      const result = await resolveAppBundleExecutable(app, fileSystem);
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "BinaryTargetError",
          path: join(programs, "App"),
          reason: expect.stringContaining(
            code === "EACCES" || code === "EPERM"
              ? "permission denied"
              : "missing",
          ),
          cause: denied,
        },
      });
    },
  );

  it("keeps missing and malformed plist diagnostics distinct", async () => {
    const directory = await createTestTempDirectory("rea-app-diagnostics-");
    const missing = join(directory, "Missing.app");
    await mkdir(join(missing, "Contents"), { recursive: true });
    const missingResult = await resolveAppBundleExecutable(missing);
    expect(missingResult).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining("missing") },
    });

    const notDirectory = join(directory, "NotDirectory.app");
    await mkdir(notDirectory, { recursive: true });
    await writeFile(join(notDirectory, "Contents"), "not a directory");
    const notDirectoryResult = await resolveAppBundleExecutable(notDirectory);
    expect(notDirectoryResult).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining("missing") },
    });

    const malformed = join(directory, "Malformed.app");
    await mkdir(join(malformed, "Contents", "MacOS"), { recursive: true });
    await writeFile(
      join(malformed, "Contents", "Info.plist"),
      "<plist><dict></dict></plist>",
    );
    const malformedResult = await resolveAppBundleExecutable(malformed);
    expect(malformedResult).toMatchObject({
      ok: false,
      error: {
        path: join(malformed, "Contents", "Info.plist"),
        reason: expect.stringContaining("malformed"),
      },
    });
  });
});

describe("binary target I/O: package classification", () => {
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
});

describe("binary target I/O: filesystem and app bundle target resolution", () => {
  it("resolves relative Hopper databases and rejects unknown or unreadable paths", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    await writeFile(join(directory, "sample.hop"), "database");
    await writeFile(join(directory, "text"), "hello");
    const database = await parseBinaryTarget("sample.hop", { cwd: directory });
    expect(database.ok && database.value.sha256).toBe(
      "3549b0028b75d981cdda2e573e9cb49dedc200185876df299f912b79f69dabd8",
    );
    expect((await parseBinaryTarget("text", { cwd: directory })).ok).toBe(
      false,
    );
    expect((await parseBinaryTarget("missing", { cwd: directory })).ok).toBe(
      false,
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable target as a host read denial",
    async () => {
      const directory = await createTestTempDirectory("rea-target-denied-");
      const path = join(directory, "unreadable");
      await writeFile(path, thinMach(0xcffaedfe, 0x0100000c));
      await chmod(path, 0);
      try {
        const result = await parseBinaryTarget(path, {
          cwd: directory,
          hostArchitecture: "arm64",
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatchObject({ path, systemCode: "EACCES" });
        expect(projectAnalysisError(result.error)).toMatchObject({
          code: "access_denied",
          details: { path, system_code: "EACCES" },
        });
      } finally {
        await chmod(path, 0o600);
      }
    },
  );

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
    const result = await parseBinaryTarget(app, {
      cwd: directory,
      hostArchitecture: "arm64",
    });
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
    expect(
      (
        await parseBinaryTarget(app, {
          cwd: directory,
          hostArchitecture: "arm64",
        })
      ).ok,
    ).toBe(false);
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
      expect(
        (
          await parseBinaryTarget(app, {
            cwd: directory,
            hostArchitecture: "arm64",
          })
        ).ok,
      ).toBe(false);
    },
  );
});

describe("binary target I/O: explicit kinds and executable headers", () => {
  it("binds and copies an existing analysis project without changing the source", async () => {
    const directory = await createTestTempDirectory("rea-analysis-project-");
    const marker = join(directory, "Firmware.gpr");
    const storage = join(directory, "Firmware.rep");
    await mkdir(join(storage, "idata", "00"), { recursive: true });
    await writeFile(marker, "marker-v1");
    await writeFile(join(storage, "project.prp"), "properties");
    await writeFile(join(storage, "idata", "00", "program.gbf"), "program");

    const parsed = await parseAnalysisProjectTarget({
      markerPath: marker,
      storagePath: storage,
      projectName: "Firmware",
      documentPath: "/folder/program.bin",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== "database") return;
    expect(parsed.value).toMatchObject({
      kind: "database",
      format: "analysis-database",
      analysisProject: {
        projectName: "Firmware",
        documentPath: "/folder/program.bin",
      },
    });
    const destination = join(directory, "private-copy");
    const copied = await copyAnalysisProject(
      parsed.value.analysisProject!,
      destination,
      parsed.value.sha256,
    );
    expect(await readFile(copied.markerPath, "utf8")).toBe("marker-v1");
    expect(
      await readFile(
        join(copied.storagePath, "idata", "00", "program.gbf"),
        "utf8",
      ),
    ).toBe("program");
    expect(await readFile(marker, "utf8")).toBe("marker-v1");
  });

  it("rejects a mismatched project name and missing backing store", async () => {
    const directory = await createTestTempDirectory("rea-analysis-project-");
    const marker = join(directory, "Firmware.gpr");
    await writeFile(marker, "marker");
    const mismatched = await parseAnalysisProjectTarget({
      markerPath: marker,
      storagePath: join(directory, "Other.rep"),
      projectName: "Other",
      documentPath: "/program.bin",
    });
    expect(mismatched).toMatchObject({
      ok: false,
      error: {
        reason: expect.stringContaining("marker must be named Other.gpr"),
      },
    });
    const missing = await parseAnalysisProjectTarget({
      markerPath: marker,
      storagePath: join(directory, "Firmware.rep"),
      projectName: "Firmware",
      documentPath: "/program.bin",
    });
    expect(missing.ok).toBe(false);
  });

  it("honors an explicit database kind without relying on the file suffix", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    await writeFile(join(directory, "saved-analysis"), "database");
    const result = await parseBinaryTarget("saved-analysis", {
      cwd: directory,
      hostArchitecture: "arm64",
      targetKind: "database",
    });
    expect(result.ok && result.value).toMatchObject({
      kind: "database",
      format: "analysis-database",
    });
  });

  it("reads a PE header beyond the initial probe", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    const path = join(directory, "delayed.exe");
    await writeFile(path, pe(0x8664, 8192));
    const result = await parseBinaryTarget(path, {
      cwd: directory,
      hostArchitecture: "x64",
    });
    expect(result.ok && result.value).toMatchObject({
      format: "pe",
      architecture: "x86_64",
    });
  });

  it("refuses a truncated Mach-O header before any provider sees it", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    const path = join(directory, "truncated");
    await writeFile(path, thinMach(0xcffaedfe, 0x0100000c).subarray(0, 12));
    const result = await parseBinaryTarget(path, {
      cwd: directory,
      hostArchitecture: "arm64",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error).toMatchObject({
      path,
      reason:
        "truncated Mach-O header: a 64-bit header needs 32 bytes; the file has 12",
    });
  });

  it("checks Mach-O load commands against the whole file beyond the probe", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    const path = join(directory, "large-commands");
    const header = thinMach(0xcffaedfe, 0x0100000c);
    header.writeUInt32LE(8192, 20);
    await writeFile(path, Buffer.concat([header, Buffer.alloc(8192)]));
    const result = await parseBinaryTarget(path, {
      cwd: directory,
      hostArchitecture: "arm64",
    });
    expect(result.ok && result.value).toMatchObject({
      format: "mach-o",
      architecture: "arm64",
    });
  });
});

describe("app executable filename fidelity", () => {
  it.each([" leading", "trailing ", " both "])(
    "preserves executable filename whitespace in an XML plist: %j",
    async (name) => {
      const directory = await createTestTempDirectory("rea-app-name-");
      const app = join(directory, "Whitespace.app");
      const contents = join(app, "Contents");
      const executable = join(contents, "MacOS", name);
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await writeFile(
        join(contents, "Info.plist"),
        `<plist><dict><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`,
      );
      await writeFile(executable, thinMach(0xfeedfacf, 0x0100000c));
      const result = await parseBinaryTarget(app, {
        cwd: directory,
        hostArchitecture: "arm64",
      });
      expect(result.ok && result.value).toMatchObject({
        path: await realpath(executable),
        format: "mach-o",
      });
    },
  );

  it.each([
    ["an escaped entity reference", "a&amp;lt;b", "a&lt;b"],
    ["a numeric character reference", "a&#32;b", "a b"],
    ["a CDATA section", "<![CDATA[a&b]]>", "a&b"],
  ])(
    "decodes an XML plist executable name containing %s",
    async (_case, encoded, name) => {
      const directory = await createTestTempDirectory("rea-app-xml-name-");
      const app = join(directory, "Encoded.app");
      const contents = join(app, "Contents");
      const executable = join(contents, "MacOS", name);
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await writeFile(
        join(contents, "Info.plist"),
        `<plist><dict><key>CFBundleExecutable</key><string>${encoded}</string></dict></plist>`,
      );
      await writeFile(executable, thinMach(0xfeedfacf, 0x0100000c));
      const result = await parseBinaryTarget(app, {
        cwd: directory,
        hostArchitecture: "arm64",
      });
      expect(result.ok && result.value).toMatchObject({
        path: await realpath(executable),
        format: "mach-o",
      });
    },
  );

  it("reads the top-level executable key rather than commented or nested text", async () => {
    const directory = await createTestTempDirectory("rea-app-xml-key-");
    const app = join(directory, "Nested.app");
    const contents = join(app, "Contents");
    const executable = join(contents, "MacOS", "App");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await writeFile(
      join(contents, "Info.plist"),
      [
        "<plist><dict>",
        "<!-- <key>CFBundleExecutable</key><string>Old</string> -->",
        "<key>NSExtension</key><dict><key>CFBundleExecutable</key><string>Inner</string></dict>",
        "<key>CFBundleExecutable</key><string>App</string>",
        "</dict></plist>",
      ].join(""),
    );
    await writeFile(executable, thinMach(0xfeedfacf, 0x0100000c));
    await writeFile(
      join(contents, "MacOS", "Old"),
      thinMach(0xfeedfacf, 0x0100000c),
    );
    await writeFile(
      join(contents, "MacOS", "Inner"),
      thinMach(0xfeedfacf, 0x0100000c),
    );
    const result = await parseBinaryTarget(app, {
      cwd: directory,
      hostArchitecture: "arm64",
    });
    expect(result.ok && result.value).toMatchObject({
      path: await realpath(executable),
    });
  });

  it.each([
    "<key>__proto__</key><dict><key>CFBundleExecutable</key><string>Forged</string></dict>",
    "<key>&#95;_proto__</key><string>x</string>",
  ])("opens an app whose XML plist also holds %s", async (entry) => {
    const directory = await createTestTempDirectory("rea-app-xml-proto-");
    const app = join(directory, "Proto.app");
    const contents = join(app, "Contents");
    const executable = join(contents, "MacOS", "App");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await writeFile(
      join(contents, "Info.plist"),
      `<plist><dict>${entry}<key>CFBundleExecutable</key><string>App</string></dict></plist>`,
    );
    await writeFile(executable, thinMach(0xfeedfacf, 0x0100000c));
    const result = await parseBinaryTarget(app, {
      cwd: directory,
      hostArchitecture: "arm64",
    });
    expect(result.ok && result.value).toMatchObject({
      path: await realpath(executable),
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "preserves executable filename whitespace from native binary plists",
    async () => {
      const directory = await createTestTempDirectory("rea-app-binary-name-");
      for (const name of ["Ordinary", " App ", "Tab\t"]) {
        const app = join(directory, `${name}.app`);
        const contents = join(app, "Contents");
        const executable = join(contents, "MacOS", name);
        const plist = join(contents, "Info.plist");
        await mkdir(join(contents, "MacOS"), { recursive: true });
        await writeFile(
          plist,
          `<plist><dict><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`,
        );
        await promisify(execFile)("/usr/bin/plutil", [
          "-convert",
          "binary1",
          plist,
        ]);
        await writeFile(executable, thinMach(0xfeedfacf, 0x0100000c));
        const result = await parseBinaryTarget(app, {
          cwd: directory,
          hostArchitecture: "arm64",
        });
        expect(result.ok && result.value).toMatchObject({
          path: await realpath(executable),
          format: "mach-o",
        });
      }
    },
  );
});

describe("iOS-style app bundle targets", () => {
  const plist = (name: string) =>
    `<plist><dict><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`;

  it("resolves a flat bundle's program file beside its Info.plist", async () => {
    const directory = await createTestTempDirectory("rea-target-");
    const app = join(directory, "Flat.app");
    await mkdir(app);
    await writeFile(join(app, "Info.plist"), plist("Flat"));
    await writeFile(join(app, "Flat"), thinMach(0xfeedfacf, 0x0100000c));
    const result = await parseBinaryTarget(app, {
      cwd: directory,
      hostArchitecture: "arm64",
    });
    expect(result.ok && result.value).toMatchObject({
      path: await realpath(join(app, "Flat")),
      bundleInfoPlist: join(await realpath(app), "Info.plist"),
      format: "mach-o",
    });
  });

  it.skipIf(process.platform === "win32")(
    "keeps the declaring Info.plist for a symlinked program file",
    async () => {
      const directory = await createTestTempDirectory("rea-target-");
      const app = join(directory, "Linked.app");
      await mkdir(join(app, "bin"), { recursive: true });
      await writeFile(join(app, "Info.plist"), plist("Linked"));
      await writeFile(
        join(app, "bin", "real"),
        thinMach(0xfeedfacf, 0x0100000c),
      );
      await symlink("bin/real", join(app, "Linked"));
      const result = await parseBinaryTarget(app, {
        cwd: directory,
        hostArchitecture: "arm64",
      });
      expect(result.ok && result.value).toMatchObject({
        path: await realpath(join(app, "bin", "real")),
        bundleInfoPlist: join(await realpath(app), "Info.plist"),
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows a readable Contents/Info.plist symlink",
    async () => {
      const directory = await createTestTempDirectory("rea-target-");
      const app = join(directory, "Linked.app");
      const contents = join(app, "Contents");
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await writeFile(join(contents, "Real.plist"), plist("Linked"));
      await symlink("Real.plist", join(contents, "Info.plist"));
      await writeFile(
        join(contents, "MacOS", "Linked"),
        thinMach(0xfeedfacf, 0x0100000c),
      );
      const result = await parseBinaryTarget(app, {
        cwd: directory,
        hostArchitecture: "arm64",
      });
      expect(result.ok && result.value).toMatchObject({
        path: await realpath(join(contents, "MacOS", "Linked")),
      });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a wrapper it cannot read as a permission denial",
    async () => {
      const directory = await createTestTempDirectory("rea-target-");
      const app = join(directory, "Locked.app");
      const wrapper = join(app, "Wrapper");
      await mkdir(join(wrapper, "Locked.app"), { recursive: true });
      await chmod(wrapper, 0o000);
      try {
        const result = await parseBinaryTarget(app, {
          cwd: directory,
          hostArchitecture: "arm64",
        });
        if (result.ok) throw new Error("Expected a permission denial");
        expect(result.error.message).toContain("permission denied");
      } finally {
        await chmod(wrapper, 0o755);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves an iOS-on-Mac wrapper through its single Wrapper bundle",
    async () => {
      const directory = await createTestTempDirectory("rea-target-");
      const app = join(directory, "Phone.app");
      const wrapped = join(app, "Wrapper", "Phone.app");
      await mkdir(wrapped, { recursive: true });
      await writeFile(join(wrapped, "Info.plist"), plist("Phone"));
      await writeFile(join(wrapped, "Phone"), thinMach(0xfeedfacf, 0x0100000c));
      await symlink("Wrapper/Phone.app", join(app, "WrappedBundle"));
      const result = await parseBinaryTarget(app, {
        cwd: directory,
        hostArchitecture: "arm64",
      });
      expect(result.ok && result.value).toMatchObject({
        path: await realpath(join(wrapped, "Phone")),
        format: "mach-o",
      });

      await mkdir(join(app, "Wrapper", "Second.app"));
      expect(
        (
          await parseBinaryTarget(app, {
            cwd: directory,
            hostArchitecture: "arm64",
          })
        ).ok,
      ).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a flat bundle program symlink that leaves the bundle",
    async () => {
      const directory = await createTestTempDirectory("rea-target-");
      const app = join(directory, "Escaping.app");
      const outside = join(directory, "outside");
      await mkdir(app);
      await writeFile(outside, thinMach(0xfeedfacf, 0x0100000c));
      await writeFile(join(app, "Info.plist"), plist("Escaping"));
      await symlink(outside, join(app, "Escaping"));
      const result = await parseBinaryTarget(app, {
        cwd: directory,
        hostArchitecture: "arm64",
      });
      if (result.ok) throw new Error("Expected an escaping program file");
      expect(result.error.message).toContain("leaves the bundle root");
    },
  );
});

describe("DOS binary target I/O", () => {
  it("validates a complete DOS file beyond the initial metadata probe", async () => {
    const directory = await createTestTempDirectory("rea-dos-target-");
    const path = join(directory, "legacy.exe");
    const bytes = dosMz(8192);
    await writeFile(path, bytes);
    expect(await parseBinaryTarget(path)).toMatchObject({
      ok: true,
      value: { format: "dos-mz", architecture: "x86", kind: "executable" },
    });
    await writeFile(path, bytes.subarray(0, bytes.length - 1));
    expect(await parseBinaryTarget(path)).toMatchObject({
      ok: false,
      error: { message: "Cannot open artifact: truncated DOS MZ load module" },
    });
  });
});
