import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { systemDoctorHost } from "../../../src/application/Doctor.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { binaryTargetSummary } from "../../../src/application/binary/BinaryTargetSummary.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { pe } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execFileAsync = promisify(execFile);
const onDarwin = process.platform === "darwin";

/** Compile a two-file C fixture with real debug symbols and a dSYM bundle. */
const compilePairFixture = async (directory: string, name: string) => {
  const source = join(directory, `${name}.c`);
  await writeFile(
    source,
    [
      "#include <stdio.h>",
      "typedef struct { int a; int b; } Pair;",
      "__attribute__((noinline)) int pair_sum(Pair p) { return p.a + p.b; }",
      'int main(void) { Pair p = {19, 23}; printf("%d\\n", pair_sum(p)); return 0; }',
      "",
    ].join("\n"),
  );
  const object = join(directory, `${name}.o`);
  const binary = join(directory, name);
  await execFileAsync("/usr/bin/xcrun", [
    "clang",
    "-O0",
    "-g",
    "-c",
    source,
    "-o",
    object,
  ]);
  await execFileAsync("/usr/bin/xcrun", ["clang", object, "-o", binary]);
  await execFileAsync("/usr/bin/xcrun", [
    "dsymutil",
    binary,
    "-o",
    `${binary}.dSYM`,
  ]);
  return binary;
};

describe("executable format refusal diagnostics", () => {
  it.each([
    [0x01a6, "0x01a6"],
    [0x0000, "0x0000"],
    [0xffff, "0xffff"],
  ] as const)(
    "retains unsupported PE machine %i in the refusal",
    async (machine, expectedMachine) => {
      const directory = await createTestTempDirectory("rea-target-pe-machine-");
      const path = join(directory, "unsupported.exe");
      const bytes = pe(0x014c);
      bytes.writeUInt16LE(machine, 0x44);
      await writeFile(path, bytes);

      const result = await parseBinaryTarget(path);
      if (result.ok) throw new Error("unsupported PE target was admitted");
      const reason = `unsupported PE architecture (COFF machine ${expectedMachine})`;
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "target_unavailable",
        category: "unsupported_target",
        message: `Cannot open artifact: ${reason}.`,
        details: { reason, constraint: "file_format_rejected" },
      });
    },
  );

  it.each(["NE", "LE", "LX"] as const)(
    "reports unsupported %s executables without path advice",
    async (signature) => {
      const directory = await createTestTempDirectory(
        `rea-target-${signature.toLowerCase()}-`,
      );
      const path = join(directory, "unsupported.exe");
      const bytes = Buffer.alloc(0x80 + 24);
      bytes.write("MZ", 0, "ascii");
      bytes.writeUInt32LE(0x80, 0x3c);
      bytes.write(signature, 0x80, "ascii");
      await writeFile(path, bytes);

      const result = await parseBinaryTarget(path);
      if (result.ok)
        throw new Error(`unsupported ${signature} target was admitted`);
      const reason = `unsupported ${signature} executable in MZ image`;
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "target_unavailable",
        category: "unsupported_target",
        retryable: false,
        message: `Cannot open artifact: ${reason}.`,
        details: {
          reason,
          constraint: "file_format_rejected",
        },
        remediation: {
          action:
            "Review the reported file-format reason and select a supported, well-formed target.",
        },
      });
      expect(projected.message).not.toContain("Check that the path");

      expect(await systemDoctorHost().inspectTarget?.(path)).toMatchObject({
        classification: "unsupported_target",
        details: { constraint: "file_format_rejected" },
        remediation:
          "Review the reported file-format reason and select a supported, well-formed target.",
      });
    },
  );
});

describe("target route diagnostics", () => {
  it.each(["module.wasm", "module.bin", "misleading.js", "misleading.hop"])(
    "identifies a WASM v1 header in %s without suggesting native provider installation",
    async (name) => {
      const directory = await createTestTempDirectory("rea-wasm-target-");
      const path = join(directory, name);
      const bytes = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
      await writeFile(path, bytes);
      const result = await parseBinaryTarget(path);
      if (result.ok) throw new Error("WASM was admitted to native opening");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "target_unavailable",
        category: "unsupported_target",
        retryable: false,
        details: {
          path: await realpath(path),
          constraint: "wasm_requires_static_inspection",
        },
      });
      expect(projected.message).toContain("WebAssembly");
      expect(projected.remediation.action).toContain("inspect_wasm_artifact");
      expect(projected.remediation.action).toContain("REA_WABT_BIN_DIRECTORY");
      expect(projected.remediation.action).toContain("WABT 1.0.42");
      expect(projected.remediation.action).toContain("does not execute");
      expect(await systemDoctorHost().inspectTarget?.(path)).toMatchObject({
        ok: false,
        classification: "unsupported_target",
        details: { constraint: "wasm_requires_static_inspection" },
        remediation: projected.remediation.action,
      });
    },
  );

  it.each([
    [0, 0x61, 0x73, 0x6d],
    [0, 0x61, 0x73, 0x6d, 2, 0, 0, 0],
    [1, 2, 3, 4, 5, 6, 7, 8],
  ])(
    "does not infer supported WASM encoding from a suffix or incomplete header",
    async (...bytes) => {
      const directory = await createTestTempDirectory("rea-wasm-unknown-");
      const path = join(directory, "module.wasm");
      await writeFile(path, Buffer.from(bytes));
      const result = await parseBinaryTarget(path);
      if (result.ok) throw new Error("unknown header was admitted");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        category: "unsupported_target",
        retryable: false,
        details: { constraint: "file_format_rejected" },
      });
      expect(projected.remediation.action).not.toContain(
        "inspect_wasm_artifact",
      );
    },
  );

  it("preserves an explicit raw-binary selection even when the bytes have a WASM header", async () => {
    const directory = await createTestTempDirectory("rea-wasm-explicit-raw-");
    const path = join(directory, "module.wasm");
    await writeFile(path, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    expect(
      await parseBinaryTarget(path, {
        formatHint: "raw-binary",
        architecture: "x86",
        entryPoint: "0x001000",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        path: await realpath(path),
        format: "raw-binary",
        architecture: "x86",
        entryPoint: "0x1000",
        entryPointSource: "0x001000",
      },
    });
  });
  it("identifies the directory opening constraint and gives the direct analysis route", async () => {
    const directory = await createTestTempDirectory("rea-js-target-");
    await writeFile(join(directory, "index.js"), "export const answer = 42;\n");
    const result = await parseBinaryTarget(directory);
    if (result.ok) throw new Error("directory was admitted as a file");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "target_unavailable",
      details: {
        path: await realpath(directory),
        constraint: "directory_requires_file",
      },
    });
    expect(projected.message).toContain("analyze_javascript_application");
    expect(projected.remediation.action).toContain("input_path");
    const doctor = systemDoctorHost();
    expect(await doctor.inspectTarget?.(directory)).toMatchObject({
      name: "target",
      ok: false,
      classification: "unsupported_target",
      details: { constraint: "directory_requires_file" },
      remediation: projected.remediation.action,
    });
    const missing = await parseBinaryTarget(join(directory, "missing"));
    if (missing.ok) throw new Error("missing target was admitted");
    const missingProjection = projectAnalysisError(missing.error);
    expect(missingProjection).toMatchObject({
      details: { reason: expect.stringContaining("does not exist") },
      message: expect.stringContaining("does not exist"),
    });
    expect(missingProjection.message).toContain(
      "Check that the path exists, is readable, and points to a supported file.",
    );
    expect(
      await doctor.inspectTarget?.(join(directory, "missing")),
    ).toMatchObject({
      ok: false,
      classification: "config_drift",
      details: { reason: expect.stringContaining("does not exist") },
    });
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "preserves a real filesystem permission denial",
    async () => {
      const directory = await createTestTempDirectory("rea-target-denied-");
      const path = join(directory, "index.js");
      await writeFile(path, "export const answer = 42;");
      await chmod(path, 0o000);
      try {
        const result = await parseBinaryTarget(path);
        if (result.ok) throw new Error("unreadable target was admitted");
        const projected = projectAnalysisError(result.error);
        expect(projected).toMatchObject({
          details: { reason: expect.stringContaining("permission denied") },
          message: expect.stringContaining("permission denied"),
        });
        expect(projected.message).toContain(
          "Check that the path exists, is readable, and points to a supported file.",
        );
        expect(await systemDoctorHost().inspectTarget?.(path)).toMatchObject({
          ok: false,
          classification: "config_drift",
          details: { reason: expect.stringContaining("permission denied") },
        });
      } finally {
        await chmod(path, 0o600);
      }
    },
  );
});

describe("raw-binary load rejection diagnostics", () => {
  const rawBinaryRejection = async (
    options: Parameters<typeof parseBinaryTarget>[1],
    bytes = Buffer.alloc(64),
  ) => {
    const directory = await createTestTempDirectory("rea-raw-load-");
    const path = join(directory, "image.bin");
    await writeFile(path, bytes);
    const result = await parseBinaryTarget(path, options);
    if (result.ok) throw new Error("invalid raw-binary load was admitted");
    return projectAnalysisError(result.error);
  };

  it("projects a misaligned arm entry as caller input without path advice", async () => {
    const projected = await rawBinaryRejection({
      formatHint: "raw-binary",
      architecture: "arm",
      entryPoint: "0x1",
    });
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: false,
      message:
        "Cannot open artifact: raw-binary arm entry_point 0x1 must be 4-byte aligned.",
      details: {
        reason: "raw-binary arm entry_point 0x1 must be 4-byte aligned",
        constraint: "load_selection_rejected",
      },
      remediation: {
        action:
          "Correct the reported load argument (--target-format, --architecture, or --entry-point on the CLI; format, architecture, or entry_point through MCP) and retry.",
      },
    });
    expect(projected.message).not.toContain("Check that the path");
  });

  it("projects an x86 entry beyond the address width as caller input", async () => {
    const projected = await rawBinaryRejection({
      formatHint: "raw-binary",
      architecture: "x86",
      entryPoint: "0xffffffffff",
    });
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: { constraint: "load_selection_rejected" },
    });
    expect(projected.message).toContain("x86 address width");
    expect(projected.message).not.toContain("Check that the path");
  });

  it("projects architecture and entry without raw-binary format as caller input", async () => {
    const projected = await rawBinaryRejection({
      architecture: "arm",
      entryPoint: "0x0",
    });
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      message:
        "Cannot open artifact: architecture and entry_point apply only with format=raw-binary.",
      details: { constraint: "load_selection_rejected" },
    });
    expect(projected.message).not.toContain("Check that the path");
  });

  it("keeps an empty raw-binary file a target refusal", async () => {
    const projected = await rawBinaryRejection(
      {
        formatHint: "raw-binary",
        architecture: "arm",
        entryPoint: "0x8000000",
      },
      Buffer.alloc(0),
    );
    expect(projected).toMatchObject({
      code: "target_unavailable",
      category: "unsupported_target",
      details: {
        reason: "raw-binary requires at least one file byte",
        constraint: "file_format_rejected",
      },
    });
  });

  it("projects the raw-binary target-kind pairing as caller input", async () => {
    const projected = await rawBinaryRejection({
      formatHint: "raw-binary",
      targetKind: "database",
      architecture: "x86",
      entryPoint: "0x1000",
    });
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        reason: "raw-binary format requires an executable target kind",
        constraint: "load_selection_rejected",
      },
    });
  });

  it("projects the DOS COM target-kind pairing as caller input too", async () => {
    const projected = await rawBinaryRejection({
      formatHint: "dos-com",
      targetKind: "database",
    });
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        reason: "DOS COM format requires an executable target kind",
        constraint: "load_selection_rejected",
      },
    });
  });
});

describe("debug companion admission diagnostics", () => {
  it("rejects dsym_path paired with an explicit headerless format", async () => {
    const directory = await createTestTempDirectory("rea-dsym-pairing-");
    const path = join(directory, "image.bin");
    await writeFile(path, Buffer.alloc(64));
    const result = await parseBinaryTarget(path, {
      formatHint: "raw-binary",
      architecture: "arm64",
      entryPoint: "0x100000000",
      dsymPath: join(directory, "image.dSYM"),
    });
    if (result.ok) throw new Error("dsym with raw-binary was admitted");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        constraint: "debug_companion_rejected",
        reason:
          "dsym_path applies only to detected Mach-O executable targets, not to explicit headerless formats",
      },
    });
  });

  it("rejects dsym_path on an artifact target instead of discarding it", async () => {
    const directory = await createTestTempDirectory("rea-dsym-artifact-");
    const path = join(directory, "bundle.zip");
    await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
    const result = await parseBinaryTarget(path, {
      dsymPath: join(directory, "bundle.dSYM"),
    });
    if (result.ok) throw new Error("dsym on a zip target was admitted");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        constraint: "debug_companion_rejected",
        reason:
          "dsym_path applies only to Mach-O executable targets; this target is zip",
      },
    });
  });

  it("rejects dsym_path on a trailing-ZIP archive target instead of discarding it", async () => {
    const directory = await createTestTempDirectory("rea-dsym-zip-tail-");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("a.txt", new TextReader("hello\n"));
    const zip = Buffer.from(await writer.close());
    const path = join(directory, "selfextractor.tool");
    await writeFile(
      path,
      Buffer.concat([Buffer.from("#!/bin/sh\nexit 0\n"), zip]),
    );
    const result = await parseBinaryTarget(path, {
      dsymPath: join(directory, "selfextractor.dSYM"),
    });
    if (result.ok)
      throw new Error("dsym with a trailing-ZIP archive was admitted");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        constraint: "debug_companion_rejected",
        reason:
          "dsym_path applies only to Mach-O executable targets; this target is an archive with a trailing ZIP",
      },
    });
  });
});

describe("debug companion fixture admission", () => {
  it.skipIf(!onDarwin)(
    "admits a matching dSYM with its UUID and member digest",
    async () => {
      const directory = await createTestTempDirectory("rea-dsym-admit-");
      const binary = await compilePairFixture(directory, "pair");
      const result = await parseBinaryTarget(binary, {
        dsymPath: `${binary}.dSYM`,
      });
      if (!result.ok)
        throw new Error(
          `matching dSYM was rejected: ${JSON.stringify(projectAnalysisError(result.error))}`,
        );
      expect(
        result.value.format === "mach-o" ||
          result.value.format === "mach-o-universal",
      ).toBe(true);
      const companion =
        result.value.format === "mach-o" ||
        result.value.format === "mach-o-universal"
          ? result.value.debugCompanion
          : undefined;
      expect(companion).toMatchObject({
        sourcePath: `${binary}.dSYM`,
        uuid: expect.stringMatching(
          /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u,
        ),
        memberSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(companion?.memberPath).toContain(
        join("Contents", "Resources", "DWARF"),
      );
      expect(binaryTargetSummary(result.value)).toMatchObject({
        debug_companion: {
          source_path: `${binary}.dSYM`,
          uuid: companion?.uuid,
          member_sha256: companion?.memberSha256,
        },
      });
    },
  );

  it.skipIf(!onDarwin)(
    "skips a non-Mach-O DWARF member such as .DS_Store during admission",
    async () => {
      const directory = await createTestTempDirectory("rea-dsym-junk-");
      const binary = await compilePairFixture(directory, "pair");
      await writeFile(
        join(`${binary}.dSYM`, "Contents", "Resources", "DWARF", ".DS_Store"),
        Buffer.alloc(64),
      );
      const result = await parseBinaryTarget(binary, {
        dsymPath: `${binary}.dSYM`,
      });
      if (!result.ok)
        throw new Error(
          `bundle with a junk member was rejected: ${JSON.stringify(projectAnalysisError(result.error))}`,
        );
      expect(
        result.value.format === "mach-o" ||
          result.value.format === "mach-o-universal",
      ).toBe(true);
    },
  );

  it.skipIf(!onDarwin)(
    "rejects a DWARF directory with too many entries",
    async () => {
      const directory = await createTestTempDirectory("rea-dsym-count-");
      const binary = await compilePairFixture(directory, "pair");
      const dwarfDirectory = join(
        `${binary}.dSYM`,
        "Contents",
        "Resources",
        "DWARF",
      );
      for (let index = 0; index < 16; index += 1)
        await writeFile(
          join(dwarfDirectory, `extra-${String(index)}`),
          Buffer.alloc(16),
        );
      const result = await parseBinaryTarget(binary, {
        dsymPath: `${binary}.dSYM`,
      });
      if (result.ok) throw new Error("oversized member count was admitted");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "invalid_request",
        details: {
          constraint: "debug_companion_rejected",
          reason: expect.stringContaining(
            "more than 16 DWARF directory entries",
          ),
        },
      });
    },
  );

  it.skipIf(!onDarwin)(
    "rejects an oversized DWARF member before hashing or staging it",
    async () => {
      const directory = await createTestTempDirectory("rea-dsym-size-");
      const binary = await compilePairFixture(directory, "pair");
      const dwarfDirectory = join(
        `${binary}.dSYM`,
        "Contents",
        "Resources",
        "DWARF",
      );
      // Replace the only matching member so enumeration order cannot bypass the size check.
      const huge = join(dwarfDirectory, "pair");
      // Preserve the real member UUID while growing its sparse extent.
      // A sparse file reports a size beyond the budget without occupying it.
      const truncate = (await import("node:fs/promises")).truncate;
      await truncate(huge, 1024 * 1024 * 1024 + 1);
      const result = await parseBinaryTarget(binary, {
        dsymPath: `${binary}.dSYM`,
      });
      if (result.ok) throw new Error("oversized member was admitted");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "invalid_request",
        details: {
          constraint: "debug_companion_rejected",
          reason: expect.stringContaining("exceeds the supported size"),
        },
      });
    },
  );

  it.skipIf(!onDarwin)(
    "rejects a mismatched dSYM as caller input with the UUID reason",
    async () => {
      const directory = await createTestTempDirectory("rea-dsym-mismatch-");
      const pair = await compilePairFixture(directory, "pair");
      const other = await compilePairFixture(directory, "other");
      const result = await parseBinaryTarget(pair, {
        dsymPath: `${other}.dSYM`,
      });
      if (result.ok) throw new Error("mismatched dSYM was admitted");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: {
          constraint: "debug_companion_rejected",
          reason:
            "dsym_path contains no Mach-O DWARF member whose LC_UUID matches the selected target slice",
        },
      });
      expect(projected.message).not.toContain("Check that the path");
    },
  );
});

describe("debug companion universal slice selection", () => {
  it("honors a UUID-less first slice over a UUID-bearing same-family sibling", async () => {
    const directory = await createTestTempDirectory("rea-dsym-nouuid-");
    const target = join(directory, "target.macho");
    // Container: first x86_64-family slice without LC_UUID, then a sibling
    // with one. The import is the first slice; the sibling must not match.
    const filler = Buffer.alloc(28 + 8);
    filler.writeUInt32LE(0xfeedface, 0);
    filler.writeUInt32LE(0x01000007, 4);
    filler.writeUInt32LE(1, 16);
    filler.writeUInt32LE(8, 20);
    filler.writeUInt32LE(0x29, 28);
    filler.writeUInt32LE(8, 32);
    const siblingUuid = "55555555-5555-5555-5555-555555555555";
    const siblingBytes = Buffer.alloc(28 + 24);
    siblingBytes.writeUInt32LE(0xfeedface, 0);
    siblingBytes.writeUInt32LE(0x01000007, 4);
    siblingBytes.writeUInt32LE(1, 16);
    siblingBytes.writeUInt32LE(24, 20);
    siblingBytes.writeUInt32LE(0x1b, 28);
    siblingBytes.writeUInt32LE(24, 32);
    Buffer.from(siblingUuid.replace(/-/gu, ""), "hex").copy(siblingBytes, 36);
    const headerSize = 8 + 2 * 20;
    const container = Buffer.alloc(
      headerSize + filler.length + siblingBytes.length,
    );
    container.writeUInt32BE(0xcafebabe, 0);
    container.writeUInt32BE(2, 4);
    container.writeInt32BE(0x01000007, 8);
    container.writeUInt32BE(headerSize, 8 + 8);
    container.writeUInt32BE(filler.length, 8 + 12);
    container.writeInt32BE(0x01000007, 8 + 20);
    container.writeUInt32BE(headerSize + filler.length, 8 + 20 + 8);
    container.writeUInt32BE(siblingBytes.length, 8 + 20 + 12);
    filler.copy(container, headerSize);
    siblingBytes.copy(container, headerSize + filler.length);
    await writeFile(target, container);
    const { readMachoFileUuidEntries } =
      await import("../../../src/application/DebugCompanionAdmission.js");
    const { open } = await import("node:fs/promises");
    const handle = await open(target, "r");
    try {
      const entries = await readMachoFileUuidEntries(handle, container.length);
      expect(entries).toEqual({
        ok: true,
        value: [
          { cpuType: 0x01000007, uuid: null },
          { cpuType: 0x01000007, uuid: siblingUuid },
        ],
      });
    } finally {
      await handle.close();
    }
    // A valid bundle whose only member carries the sibling's UUID: the
    // import is the UUID-less first slice, so admission must still refuse.
    const bundle = join(directory, "sibling-only.dSYM");
    const dwarfDirectory = join(bundle, "Contents", "Resources", "DWARF");
    const mkdir = (await import("node:fs/promises")).mkdir;
    await mkdir(dwarfDirectory, { recursive: true });
    await writeFile(join(dwarfDirectory, "member"), siblingBytes);
    const result = await parseBinaryTarget(target, {
      dsymPath: bundle,
      hostArchitecture: "x64",
    });
    if (result.ok) throw new Error("uuid-less target admitted a companion");
    const projected = projectAnalysisError(result.error);
    expect(projected.details).toMatchObject({
      constraint: "debug_companion_rejected",
      reason: expect.stringContaining("declares no usable LC_UUID"),
    });
  });
  it.skipIf(!onDarwin || process.arch !== "arm64")(
    "rejects a companion that matches only the unselected universal slice",
    async () => {
      const directory = await createTestTempDirectory("rea-dsym-universal-");
      const source = join(directory, "universal.c");
      await writeFile(
        source,
        [
          "#include <stdio.h>",
          "typedef struct { int a; int b; } Pair;",
          "__attribute__((noinline)) int pair_sum(Pair p) { return p.a + p.b; }",
          'int main(void) { Pair p = {19, 23}; printf("%d\\n", pair_sum(p)); return 0; }',
          "",
        ].join("\n"),
      );
      const object = join(directory, "universal.o");
      const binary = join(directory, "universal");
      await execFileAsync("/usr/bin/xcrun", [
        "clang",
        "-O0",
        "-g",
        "-c",
        source,
        "-o",
        object,
        "-arch",
        "arm64",
        "-arch",
        "x86_64",
      ]);
      await execFileAsync("/usr/bin/xcrun", [
        "clang",
        object,
        "-o",
        binary,
        "-arch",
        "arm64",
        "-arch",
        "x86_64",
      ]);
      await execFileAsync("/usr/bin/xcrun", [
        "dsymutil",
        binary,
        "-o",
        `${binary}.dSYM`,
      ]);
      const member = `${binary}.dSYM/Contents/Resources/DWARF/${"universal"}`;
      const x86Only = join(directory, "x86-only.dSYM");
      await execFileAsync("mkdir", [
        "-p",
        `${x86Only}/Contents/Resources/DWARF`,
      ]);
      await execFileAsync("/usr/bin/xcrun", [
        "lipo",
        "-thin",
        "x86_64",
        member,
        "-output",
        `${x86Only}/Contents/Resources/DWARF/universal`,
      ]);
      const result = await parseBinaryTarget(binary, { dsymPath: x86Only });
      if (result.ok) throw new Error("unselected-slice companion was admitted");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: {
          constraint: "debug_companion_rejected",
          reason:
            "dsym_path contains no Mach-O DWARF member whose LC_UUID matches the selected target slice",
        },
      });
    },
  );
});

describe("debug companion slice selection", () => {
  it.skipIf(!onDarwin)(
    "admits only the first slice of a CPU family, not a same-family sibling",
    async () => {
      const directory = await createTestTempDirectory("rea-dsym-sibling-");
      const source = join(directory, "sibling.c");
      await writeFile(
        source,
        [
          "#include <stdio.h>",
          "__attribute__((noinline)) int twice(int x) { return x * 2; }",
          'int main(void) { printf("%d\\n", twice(21)); return 0; }',
          "",
        ].join("\n"),
      );
      const object = join(directory, "sibling.o");
      const binary = join(directory, "sibling");
      await execFileAsync("/usr/bin/xcrun", [
        "clang",
        "-O0",
        "-g",
        "-c",
        source,
        "-o",
        object,
        "-arch",
        "x86_64",
        "-arch",
        "x86_64h",
      ]);
      await execFileAsync("/usr/bin/xcrun", [
        "clang",
        object,
        "-o",
        binary,
        "-arch",
        "x86_64",
        "-arch",
        "x86_64h",
      ]);
      await execFileAsync("/usr/bin/xcrun", [
        "dsymutil",
        binary,
        "-o",
        `${binary}.dSYM`,
      ]);
      const member = `${binary}.dSYM/Contents/Resources/DWARF/sibling`;
      const siblingOnly = join(directory, "sibling-only.dSYM");
      await execFileAsync("mkdir", [
        "-p",
        `${siblingOnly}/Contents/Resources/DWARF`,
      ]);
      await execFileAsync("/usr/bin/xcrun", [
        "lipo",
        "-thin",
        "x86_64h",
        member,
        "-output",
        `${siblingOnly}/Contents/Resources/DWARF/sibling`,
      ]);
      // The host-compat selection imports the first x86_64 family slice; a
      // companion carrying only the x86_64h sibling UUID must not match.
      const result = await parseBinaryTarget(binary, {
        dsymPath: siblingOnly,
        hostArchitecture: "x64",
      });
      if (result.ok)
        throw new Error("same-family sibling companion was admitted");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "invalid_request",
        details: {
          constraint: "debug_companion_rejected",
          reason:
            "dsym_path contains no Mach-O DWARF member whose LC_UUID matches the selected target slice",
        },
      });
    },
  );

  it("admits a watchOS arm64_32 companion by its own cputype", async () => {
    const directory = await createTestTempDirectory("rea-dsym-arm6432-");
    const uuid = "0123456789abcdef0123456789abcdef";
    // Thin 32-bit Mach-O with LC_UUID; arm64_32 is cputype 0x0200000c, not
    // arm64's 0x0100000c, so a family table keyed on the wrong constant would
    // report the target as UUID-less and refuse this companion.
    const thinArm64_32 = (): Buffer => {
      const bytes = Buffer.alloc(28 + 24);
      bytes.writeUInt32LE(0xfeedface, 0);
      bytes.writeInt32LE(0x0200000c, 4);
      bytes.writeUInt32LE(1, 16);
      bytes.writeUInt32LE(24, 20);
      bytes.writeUInt32LE(0x1b, 28);
      bytes.writeUInt32LE(24, 32);
      Buffer.from(uuid, "hex").copy(bytes, 36);
      return bytes;
    };
    const target = join(directory, "watch.macho");
    await writeFile(target, thinArm64_32());
    const bundle = join(directory, "watch.dSYM");
    await mkdir(`${bundle}/Contents/Resources/DWARF`, { recursive: true });
    await writeFile(`${bundle}/Contents/Resources/DWARF/watch`, thinArm64_32());
    const result = await parseBinaryTarget(target, { dsymPath: bundle });
    if (!result.ok) {
      throw new Error(
        `arm64_32 companion was rejected: ${JSON.stringify(result.error)}`,
      );
    }
    expect(result.value).toMatchObject({
      format: "mach-o",
      architecture: "arm64_32",
      debugCompanion: { uuid: "01234567-89AB-CDEF-0123-456789ABCDEF" },
    });
  });
});

describe("caller-selected and inferred target interpretation", () => {
  it.each(["archive.hop", "archive.HOP"])(
    "preserves inferred database routing for ZIP content named %s",
    async (name) => {
      const directory = await createTestTempDirectory("rea-zip-database-");
      const bytes = Buffer.alloc(22);
      bytes.writeUInt32LE(0x06054b50, 0);
      const zipPath = join(directory, "archive.zip");
      const databasePath = join(directory, name);
      await writeFile(zipPath, bytes);
      await writeFile(databasePath, bytes);
      expect(await parseBinaryTarget(zipPath)).toMatchObject({
        ok: true,
        value: { kind: "archive", format: "zip" },
      });
      expect(await parseBinaryTarget(databasePath)).toMatchObject({
        ok: true,
        value: { kind: "database", format: "analysis-database" },
      });
      expect((await readFile(databasePath)).equals(bytes)).toBe(true);
    },
  );

  it("preserves explicit DOS COM interpretation for bytes with a WASM header", async () => {
    const directory = await createTestTempDirectory("rea-wasm-explicit-com-");
    const path = join(directory, "module.hop");
    await writeFile(path, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    expect(
      await parseBinaryTarget(path, { formatHint: "dos-com" }),
    ).toMatchObject({
      ok: true,
      value: { kind: "executable", format: "dos-com", architecture: "x86" },
    });
  });
  it.each(["module.wasm", "misleading.hop"])(
    "preserves explicitly selected database routing for %s",
    async (name) => {
      const directory = await createTestTempDirectory(
        "rea-wasm-explicit-database-",
      );
      const path = join(directory, name);
      await writeFile(path, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
      expect(
        await parseBinaryTarget(path, { targetKind: "database" }),
      ).toMatchObject({
        ok: true,
        value: { kind: "database", format: "analysis-database" },
      });
    },
  );

  it.each(["ordinary.hop", "ordinary.HOP"])(
    "retains automatic database routing for non-WASM %s",
    async (name) => {
      const directory = await createTestTempDirectory("rea-ordinary-database-");
      const path = join(directory, name);
      await writeFile(path, "existing database content");
      expect(await parseBinaryTarget(path)).toMatchObject({
        ok: true,
        value: { kind: "database", format: "analysis-database" },
      });
    },
  );
});
