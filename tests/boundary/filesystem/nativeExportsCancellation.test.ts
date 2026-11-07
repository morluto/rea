import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createNativeExportsService } from "../../../src/composition/binaryDiagnostics.js";
import * as elfSymbols from "../../../src/domain/elfSymbol.js";
import * as nativeExports from "../../../src/domain/native/nativeExports.js";
import { parseNativeExports } from "../../../src/native/exports/NativeExportParser.js";
import { BinaryReader } from "../../../src/native/metadata/BinaryContainer.js";
import {
  elfAliasedVersionImage,
  elfExportImage,
  peExportImage,
} from "../../fixtures/binaryDiagnostics/nativeExports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const PE_ROWS = 4096;
const PE_FUNCTIONS_OFFSET = 0x800;
const PE_NAME = "cancellable_export";
const PE_FORWARDER = "dependency.cancellable_export";
type PeStage = "names" | "addresses" | "aliases";

/** Keep each large PE traversal separate, including many aliases of one slot. */
const peCheckpointImage = (stage: PeStage): Buffer => {
  const functionCount = stage === "addresses" ? PE_ROWS : 1;
  const nameCount = stage === "addresses" ? 0 : PE_ROWS;
  const names = PE_FUNCTIONS_OFFSET + functionCount * 4;
  const ordinals = names + nameCount * 4;
  const text = ordinals + nameCount * 2;
  const bytes = Buffer.alloc(text + PE_NAME.length + 1);
  peExportImage({ functions: [{ rva: 0x3000 }] }).copy(bytes);
  const section = 152 + 240;
  bytes.writeUInt32LE(bytes.length - 0x400, section + 8);
  bytes.writeUInt32LE(bytes.length - 0x400, section + 16);
  const rva = (offset: number): number => offset - 0x400 + 0x1000;
  bytes.writeUInt32LE(functionCount, 0x400 + 20);
  bytes.writeUInt32LE(nameCount, 0x400 + 24);
  bytes.writeUInt32LE(rva(PE_FUNCTIONS_OFFSET), 0x400 + 28);
  bytes.writeUInt32LE(rva(names), 0x400 + 32);
  bytes.writeUInt32LE(rva(ordinals), 0x400 + 36);
  for (let index = 0; index < functionCount; index++)
    bytes.writeUInt32LE(
      stage === "aliases" ? 0x1100 : 0x3000 + index * 4,
      PE_FUNCTIONS_OFFSET + index * 4,
    );
  for (let index = 0; index < nameCount; index++)
    bytes.writeUInt32LE(rva(text), names + index * 4);
  bytes.write(PE_NAME, text, "latin1");
  if (stage === "aliases") bytes.write(`${PE_FORWARDER}\0`, 0x500, "latin1");
  return bytes;
};

describe("ELF export parsing cancellation", () => {
  it("observes an event-loop cancellation during symbol decoding and permits a later inspection", async () => {
    const root = await createTestTempDirectory("rea-native-export-cancel-");
    const path = join(root, "many-exports.so");
    const names = Array.from({ length: 4096 }, (_, index) => `export_${index}`);
    const bytes = elfExportImage({ symbols: names.map((name) => ({ name })) });
    await writeFile(path, bytes);
    const service = createNativeExportsService();
    const controller = new AbortController();
    const reason = { request: "stop native export parsing" };
    const readSymbol = elfSymbols.readElfSymbol;
    let decoded = 0;
    let interrupt: NodeJS.Immediate | undefined;
    const observed = vi
      .spyOn(elfSymbols, "readElfSymbol")
      .mockImplementation((...args) => {
        const result = readSymbol(...args);
        decoded += 1;
        // Queue the interrupt only after real parsing began, not during the
        // asynchronous file read. The production decoder remains unchanged.
        if (decoded === 17)
          interrupt = setImmediate(() => controller.abort(reason));
        return result;
      });
    try {
      const cancelled = await service.inspect(
        { path },
        { signal: controller.signal },
      );
      expect(decoded).toBeGreaterThanOrEqual(17);
      expect(cancelled).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisCancelledError" },
      });
      if (cancelled.ok) throw new Error("Expected cancellation while parsing");
      expect(cancelled.error.cause).toBe(reason);
      expect(decoded).toBeLessThan(names.length);

      observed.mockRestore();
      const retried = await service.inspect({ path });
      if (!retried.ok) throw retried.error;
      const report = nativeExports.nativeExportsSchema.parse(
        retried.value.normalized_result,
      );
      expect(report).toMatchObject({
        artifact: {
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
        format: "elf",
        coverage: {
          status: "complete",
          examined_entries: names.length,
          exports: names.length,
        },
        issues: [],
      });
      expect(report.exports.map(({ name }) => name)).toEqual(names);
    } finally {
      clearImmediate(interrupt);
      observed.mockRestore();
      await service.close();
    }
  });

  it.each(["requirements", "definitions"] as const)(
    "cancels while traversing GNU version %s before decoding symbols",
    async (kind) => {
      const root = await createTestTempDirectory("rea-native-version-cancel-");
      const path = join(root, `${kind}.so`);
      await writeFile(path, elfAliasedVersionImage(kind));
      const service = createNativeExportsService();
      const controller = new AbortController();
      const reason = { request: "stop version traversal", kind };
      const decodeName = nativeExports.decodeElfExportName;
      let interrupt: NodeJS.Immediate | undefined;
      const decoded = vi
        .spyOn(nativeExports, "decodeElfExportName")
        .mockImplementation((bytes) => {
          const result = decodeName(bytes);
          interrupt ??= setImmediate(() => controller.abort(reason));
          return result;
        });
      const symbols = vi.spyOn(elfSymbols, "readElfSymbol");
      try {
        const cancelled = await service.inspect(
          { path },
          { signal: controller.signal },
        );
        expect(decoded).toHaveBeenCalled();
        expect(cancelled).toMatchObject({
          ok: false,
          error: { _tag: "AnalysisCancelledError" },
        });
        if (cancelled.ok)
          throw new Error("Expected cancellation during version traversal");
        expect(cancelled.error.cause).toBe(reason);
        expect(symbols).not.toHaveBeenCalled();
      } finally {
        clearImmediate(interrupt);
        decoded.mockRestore();
        symbols.mockRestore();
        await service.close();
      }
    },
  );
});

describe("PE export parsing cancellation", () => {
  it.each(["names", "addresses", "aliases"] as const)(
    "observes cancellation during PE %s and preserves successful output on retry",
    async (stage) => {
      const root = await createTestTempDirectory("rea-pe-export-cancel-");
      const path = join(root, `${stage}.dll`);
      const bytes = peCheckpointImage(stage);
      await writeFile(path, bytes);
      const service = createNativeExportsService();
      const controller = new AbortController();
      const reason = { request: "stop PE export traversal", stage };
      let visited = 0;
      let interrupt: NodeJS.Immediate | undefined;
      const visit = (): void => {
        visited += 1;
        if (visited === 17)
          interrupt = setImmediate(() => controller.abort(reason));
      };
      // Forward every real read and text-budget charge, scheduling cancellation
      // only after the selected parser loop has actually processed entries.
      const byteLength = Buffer.byteLength;
      const retained = vi
        .spyOn(Buffer, "byteLength")
        .mockImplementation((value, encoding) => {
          const result = byteLength(value, encoding);
          if (
            (stage === "names" && value === PE_NAME) ||
            (stage === "aliases" && value === PE_FORWARDER)
          )
            visit();
          return result;
        });
      const readAddress = BinaryReader.prototype.u32;
      const addresses = vi
        .spyOn(BinaryReader.prototype, "u32")
        .mockImplementation(function (this: BinaryReader, offset) {
          const result = readAddress.call(this, offset);
          if (
            stage === "addresses" &&
            offset >= PE_FUNCTIONS_OFFSET &&
            offset < PE_FUNCTIONS_OFFSET + PE_ROWS * 4
          )
            visit();
          return result;
        });
      try {
        const cancelled = await service.inspect(
          { path },
          { signal: controller.signal },
        );
        expect(visited).toBeGreaterThanOrEqual(17);
        expect(cancelled).toMatchObject({
          ok: false,
          error: { _tag: "AnalysisCancelledError" },
        });
        if (cancelled.ok)
          throw new Error("Expected cancellation during PE parsing");
        expect(cancelled.error.cause).toBe(reason);
        expect(visited).toBeLessThan(PE_ROWS);

        retained.mockRestore();
        addresses.mockRestore();
        const retried = await service.inspect({ path });
        if (!retried.ok) throw retried.error;
        const report = nativeExports.nativeExportsSchema.parse(
          retried.value.normalized_result,
        );
        const artifact = {
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        };
        expect(report).toEqual(parseNativeExports(bytes, artifact));
        expect(report).toMatchObject({
          artifact,
          format: "pe",
          export_directory: { dll_name: "fixture.dll" },
          coverage: {
            status: "complete",
            examined_entries: stage === "addresses" ? PE_ROWS : 1,
            exports: PE_ROWS,
          },
          issues: [],
        });
      } finally {
        clearImmediate(interrupt);
        retained.mockRestore();
        addresses.mockRestore();
        await service.close();
      }
    },
  );
});
