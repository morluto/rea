import { createHash } from "node:crypto";
import { symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createNativeExportsService } from "../../../src/composition/binaryDiagnostics/nativeExports.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  MAX_NATIVE_EXPORT_ROWS,
  nativeExportsSchema,
} from "../../../src/domain/native/nativeExports.js";
import {
  elfExportImage,
  peExportImage,
  peStoredExportTableImage,
  peRepeatedExportNamesImage,
} from "../../fixtures/binaryDiagnostics/nativeExports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("native export stable filesystem boundary", () => {
  it("retains source identity and usable exports when a forwarder leaves its declared directory", async () => {
    const root = await createTestTempDirectory("rea-native-export-forwarder-");
    const path = join(root, "truncated-forwarder.dll");
    const bytes = peExportImage({
      functions: [{ rva: 0x11fc }, { rva: 0x2000 }],
      names: [{ name: "Kept", index: 1 }],
    });
    bytes.write("DLL.Target\0", 0x5fc, "latin1");
    await writeFile(path, bytes);
    const service = createNativeExportsService();
    try {
      const result = await service.inspect({ path });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const evidence = parseEvidence(result.value);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      expect(evidence.subject).toMatchObject({
        local_path: path,
        identity: { sha256 },
      });
      expect(
        nativeExportsSchema.parse(evidence.normalized_result),
      ).toMatchObject({
        artifact: { path, sha256, bytes: bytes.length },
        exports: [{ name: "Kept", ordinal: 2 }],
        issues: [
          {
            code: "malformed_entry",
            location: "0x11fc",
            message: expect.stringContaining("Forwarder of ordinal 1"),
          },
        ],
        coverage: { status: "partial", examined_entries: 2, exports: 1 },
      });
    } finally {
      await service.close();
    }
  });

  it("bounds retained PE aliases before interpreting their target", async () => {
    const root = await createTestTempDirectory("rea-native-export-aliases-");
    const service = createNativeExportsService();
    try {
      // A malformed forwarder suppresses all rows, but its names still occupy
      // the intermediate inventory and must be bounded before EAT traversal.
      for (const target of [0x3000, 0x1080, 0]) {
        const path = join(root, `aliases-${String(target)}.dll`);
        const bytes = peRepeatedExportNamesImage(target);
        expect(bytes.length).toBeLessThan(32_000);
        await writeFile(path, bytes);
        const result = await service.inspect({ path });
        if (target === 0) {
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          expect(result.value.normalized_result).toMatchObject({
            exports: [],
            issues: [],
            coverage: { status: "complete", examined_entries: 1, exports: 0 },
          });
        } else {
          // 4100 aliases of one 4096-byte name exceed the 16 MiB retained-text
          // byte budget while staying far below the 262144-entry ceiling, so
          // recovery must name the byte allowance, not the entry count.
          if (result.ok) throw new Error("Expected retained-text refusal");
          expect(result.error).toMatchObject({
            _tag: "AnalysisResourceConstraintError",
            resource: "capacity",
            reportedLimits: { boundary: "retained_text", maximum: 16777216 },
            retryable: false,
            fixedAllowance: {
              name: "The native export retained-text allowance",
              kind: "bytes",
              limit: 16777216,
              unit: "bytes",
            },
          });
        }
      }
    } finally {
      await service.close();
    }
  });

  it("binds PE and ELF export inventories to the selected file", async () => {
    const root = await createTestTempDirectory("rea-native-exports-");
    const service = createNativeExportsService();
    for (const [name, bytes, format] of [
      [
        "fixture.dll",
        peExportImage({
          functions: [{ rva: 0x2000 }],
          names: [{ name: "Exported", index: 0 }],
        }),
        "pe",
      ],
      [
        "libfixture.so",
        elfExportImage({ symbols: [{ name: "exported" }] }),
        "elf",
      ],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await service.inspect({ path });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const evidence = parseEvidence(result.value);
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      expect(evidence).toMatchObject({
        operation: "inspect_native_exports",
        provider: { id: "rea-native-exports" },
        confidence: "observed",
        subject: { local_path: path, identity: { format, sha256 } },
      });
      expect(
        nativeExportsSchema.parse(evidence.normalized_result),
      ).toMatchObject({
        artifact: { path, sha256, bytes: bytes.length },
        format,
        coverage: { status: "complete", exports: 1 },
      });
    }
    await service.close();
  });
});

it("observes cancellation during a bounded ELF export inventory", async () => {
  const root = await createTestTempDirectory("rea-native-export-cancel-");
  const path = join(root, "libfixture.so");
  const bytes = elfExportImage({
    symbols: Array.from({ length: 1025 }, () => ({ name: "exported" })),
  });
  await writeFile(path, bytes);
  const service = createNativeExportsService();
  const controller = new AbortController();
  const reason = new Error("stop during export rows");
  const yieldToEventLoop = scheduler.yield.bind(scheduler);
  const pause = vi
    .spyOn(scheduler, "yield")
    .mockImplementationOnce(async () => {
      await yieldToEventLoop();
      controller.abort(reason);
    });
  try {
    const result = await service.inspect(
      { path },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation during export rows");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      operation: "inspect_native_exports",
      cause: reason,
      partialObservation: {
        kind: "file-snapshot-hash",
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
    });
    const retry = await service.inspect(
      { path },
      { signal: new AbortController().signal },
    );
    if (!retry.ok) throw retry.error;
    expect(retry.value.normalized_result).toMatchObject({
      coverage: { status: "complete", examined_entries: 1025, exports: 1025 },
    });
  } finally {
    pause.mockRestore();
    await service.close();
  }
});

describe("native export text capacity", () => {
  it("retains valid exports and partial Evidence when a symbol name exceeds the read allowance", async () => {
    const root = await createTestTempDirectory("rea-native-export-name-limit-");
    const path = join(root, "libfixture.so");
    const bytes = elfExportImage({
      symbols: [{ name: "n".repeat(65_536) }, { name: "kept" }],
    });
    await writeFile(path, bytes);
    const service = createNativeExportsService();
    try {
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      const evidence = parseEvidence(result.value);
      const report = nativeExportsSchema.parse(evidence.normalized_result);
      expect(evidence.subject).toMatchObject({
        local_path: path,
        identity: { sha256: createHash("sha256").update(bytes).digest("hex") },
      });
      expect(report).toMatchObject({
        exports: [expect.objectContaining({ name: "kept" })],
        coverage: { status: "partial" },
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "name_unreadable",
            message: expect.stringContaining("65536-byte read allowance"),
          }),
        ]),
      });
    } finally {
      await service.close();
    }
  });

  it.each(["symbol", "version"] as const)(
    "bounds UTF-8 bytes of retained ELF %s text and its exact-byte spelling",
    async (kind) => {
      const root = await createTestTempDirectory("rea-native-export-text-");
      const service = createNativeExportsService();
      const text = "€".repeat(20_000);
      const rawName = Buffer.from(text, "utf8").toString("latin1");
      try {
        for (const count of [119, 160]) {
          const path = join(root, `${kind}-${String(count)}.so`);
          const bytes = elfExportImage({
            symbols: Array.from({ length: count }, () =>
              kind === "symbol" ? { name: rawName } : { name: "a", version: 2 },
            ),
            ...(kind === "version"
              ? { versionDefinitions: ["lib.so", rawName] }
              : {}),
          });
          expect(bytes.length).toBeLessThan(70_000);
          await writeFile(path, bytes);
          const result = await service.inspect({ path });
          if (count === 160) {
            expect(result).toMatchObject({
              ok: false,
              error: { _tag: "AnalysisResourceConstraintError" },
            });
            continue;
          }
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          const report = nativeExportsSchema.parse(
            result.value.normalized_result,
          );
          if (report.format !== "elf") throw new Error("Expected ELF report");
          expect(report.coverage).toMatchObject({
            status: "complete",
            exports: count,
          });
          const row = report.exports[0]!;
          const name = kind === "symbol" ? row : row.version;
          expect(name).toMatchObject({
            name: text,
            name_bytes_base64: Buffer.from(text, "utf8").toString("base64"),
            name_utf8_decodable: true,
          });
        }
      } finally {
        await service.close();
      }
    },
  );

  it("bounds intermediate ELF version names even when no symbols use them", async () => {
    const root = await createTestTempDirectory("rea-native-export-versions-");
    const service = createNativeExportsService();
    try {
      for (const count of [279, 280]) {
        const path = join(root, `versions-${String(count)}.so`);
        const bytes = elfExportImage({
          symbols: [],
          versionDefinitions: Array<string>(count).fill("v".repeat(60_000)),
          // Definitions replace requirements at the same indices; released
          // names must not remain charged against the live map's allowance.
          ...(count === 279
            ? {
                versionRequirements: Array.from(
                  { length: count },
                  (_, index) => ({
                    index: index + 1,
                    name: "w".repeat(60_000),
                  }),
                ),
              }
            : {}),
        });
        expect(bytes.length).toBeLessThan(140_000);
        await writeFile(path, bytes);
        const result = await service.inspect({ path });
        if (count === 280)
          expect(result).toMatchObject({
            ok: false,
            error: { _tag: "AnalysisResourceConstraintError" },
          });
        else {
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          expect(result.value.normalized_result).toMatchObject({
            exports: [],
            issues: [],
            coverage: { status: "complete", exports: 0 },
          });
        }
      }
    } finally {
      await service.close();
    }
  });
});

describe("native export entry allowance", () => {
  it.each([false, true])(
    "reports whether an oversized ELF dynamic symbol table is file-backed (%s)",
    async (stored) => {
      const bytes = elfExportImage({ symbols: [{ name: "exported" }] });
      const symbolSection = Number(bytes.readBigUInt64LE(40)) + 64;
      const size = (MAX_NATIVE_EXPORT_ROWS + 1) * 24;
      bytes.writeBigUInt64LE(BigInt(bytes.length), symbolSection + 24);
      bytes.writeBigUInt64LE(BigInt(size), symbolSection + 32);
      const root = await createTestTempDirectory("rea-native-export-dynsym-");
      const path = join(root, "rows.so");
      await writeFile(path, bytes);
      if (stored) await truncate(path, bytes.length + size);
      const service = createNativeExportsService();
      try {
        const result = await service.inspect({ path });
        if (result.ok) throw new Error("Expected a symbol-table refusal");
        const projected = projectAnalysisError(result.error);
        if (stored)
          expect(projected).toMatchObject({
            code: "resource_constraint",
            details: {
              reported_limits: {
                boundary: "rows",
                maximum: MAX_NATIVE_EXPORT_ROWS,
              },
            },
          });
        else
          expect(projected).toMatchObject({
            code: "unsupported_target",
            category: "unsupported_target",
            details: {
              path,
              reason: expect.stringContaining(
                "ELF dynamic symbols range is outside the file",
              ),
            },
          });
      } finally {
        await service.close();
      }
    },
  );

  it.each([
    ["stored", () => peStoredExportTableImage(0x40001)],
    [
      "truncated",
      () => peExportImage({ functions: [], declaredFunctions: 0x40001 }),
    ],
  ])(
    "keeps count recovery for a %s export table above the entry allowance",
    async (_case, image) => {
      const root = await createTestTempDirectory("rea-native-export-rows-");
      const path = join(root, "rows.dll");
      await writeFile(path, image());
      const service = createNativeExportsService();
      try {
        const result = await service.inspect({ path });
        if (result.ok) throw new Error("Expected entry allowance refusal");
        expect(result.error).toMatchObject({
          _tag: "AnalysisResourceConstraintError",
          resource: "capacity",
          reportedLimits: { boundary: "rows", maximum: MAX_NATIVE_EXPORT_ROWS },
          retryable: false,
          fixedAllowance: {
            name: "The native export inventory allowance",
            kind: "count",
            limit: MAX_NATIVE_EXPORT_ROWS,
            unit: "entries",
          },
        });
      } finally {
        await service.close();
      }
    },
  );
});

describe("native export encoding and failures", () => {
  it("keeps ELF symbol bytes while exposing valid UTF-8 text", async () => {
    const root = await createTestTempDirectory("rea-native-export-unicode-");
    const path = join(root, "libfixture.so");
    const bytes = elfExportImage({
      symbols: [{ name: "cafÃ©", version: 2 }, { name: "\u00ff" }],
      versionDefinitions: ["libfixture.so", "libcafÃ©.so"],
    });
    await writeFile(path, bytes);
    const service = createNativeExportsService();
    const result = await service.inspect({ path });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.normalized_result).toMatchObject({
      format: "elf",
      exports: [
        {
          name: "café",
          name_bytes_base64: "Y2Fmw6k=",
          name_utf8_decodable: true,
          version: {
            index: 2,
            name: "libcafé.so",
            name_bytes_base64: "bGliY2Fmw6kuc28=",
            name_utf8_decodable: true,
          },
        },
        {
          name: "ÿ",
          name_bytes_base64: "/w==",
          name_utf8_decodable: false,
        },
      ],
    });
    const withoutEncoding = JSON.parse(
      JSON.stringify(result.value.normalized_result),
    ) as { exports: Record<string, unknown>[] };
    for (const row of withoutEncoding.exports) {
      delete row.name_bytes_base64;
      delete row.name_utf8_decodable;
    }
    expect(
      nativeExportsSchema
        .safeParse(withoutEncoding)
        .error?.issues.map(({ path }) => path.join(".")),
    ).toEqual(
      expect.arrayContaining([
        "exports.0.name_bytes_base64",
        "exports.0.name_utf8_decodable",
      ]),
    );
    await service.close();
  });

  it("returns typed input, unsupported, budget and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-native-export-failures-");
    const path = join(root, "fixture.dll");
    const alias = join(root, "alias.dll");
    const macho = join(root, "fixture.dylib");
    const malformed = join(root, "malformed.dll");
    await writeFile(path, peExportImage({ functions: [] }));
    const machoBytes = Buffer.alloc(64);
    machoBytes.writeUInt32LE(0xfeedfacf, 0);
    await writeFile(macho, machoBytes);
    await writeFile(malformed, Buffer.from("MZ not a PE image"));
    await symlink(path, alias);
    const service = createNativeExportsService();
    const failure = async (
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const result = await service.inspect(
        input,
        signal === undefined ? undefined : { signal },
      );
      if (result.ok) throw new Error("Expected a failure");
      return result.error;
    };

    for (const [candidate, reason] of [
      [alias, "invalid_format"],
      [join(root, "missing.dll"), "invalid_value"],
    ] as const)
      expect(await failure({ path: candidate })).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_native_exports",
        issues: [{ path: ["path"], reason }],
      });
    // Malformed bytes are a target refusal, not a request-field error.
    expect(await failure({ path: malformed })).toMatchObject({
      _tag: "AnalysisMalformedTargetError",
      operation: "inspect_native_exports",
      path: malformed,
    });
    expect(await failure({ path: macho })).toMatchObject({
      _tag: "AnalysisUnsupportedTargetError",
      reason: expect.stringContaining("inspect_macho"),
    });
    expect(await failure({ path, max_file_bytes: 64 })).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
    });
    expect(
      await failure({ path }, AbortSignal.abort("caller stop")),
    ).toMatchObject({ _tag: "AnalysisCancelledError" });
    await service.close();
  });
});
