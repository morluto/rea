import { createHash } from "node:crypto";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { inspectFirmwareVectorTableInputSchema } from "../../domain/firmware/firmwareVectorTable.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { FirmwareVectorTableProvider } from "./FirmwareVectorTableProvider.js";

describe("FirmwareVectorTableProvider", () => {
  it("streams whole-file SHA-256 and reads only the bounded vector-table slice at non-zero offsets", async () => {
    const dir = await createTestTempDirectory("rea-fw-vt-slice-");
    const fwPath = join(dir, "large.bin");
    // 256 KiB image with a relocated VTOR table at 0x20080 (128-byte aligned, non-64KiB-chunk boundary)
    const image = Buffer.alloc(256 * 1024, 0xff);
    const offset = 0x20080;
    image.writeUInt32LE(0x20020000, offset);
    image.writeUInt32LE(0x08020101, offset + 4);
    await writeFile(fwPath, image);
    const expectedSha256 = createHash("sha256").update(image).digest("hex");

    const positionalLengths: number[] = [];
    let maxBufferBytes = 0;
    const provider = new FirmwareVectorTableProvider({
      fileSystem: {
        lstat: (path) => lstat(path, { bigint: true }),
        realpath,
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          const originalRead = handle.read.bind(handle);
          handle.read = (async (
            buffer: Buffer,
            bufOffset?: number | null,
            length?: number | null,
            position?: number | bigint | null,
          ) => {
            if (buffer.length > maxBufferBytes) maxBufferBytes = buffer.length;
            if (typeof position === "number" && position === offset) {
              positionalLengths.push(length ?? 0);
            }
            return originalRead(
              buffer,
              bufOffset ?? 0,
              length ?? buffer.length,
              position ?? null,
            );
          }) as typeof handle.read;
          return handle;
        },
      },
    });

    const input = inspectFirmwareVectorTableInputSchema.parse({
      path: fwPath,
      architecture: "armv7-m",
      base_address: "0x08000000",
      vector_table_offset: offset,
      max_entries: 16,
    });
    const res = await provider.inspect(input);
    await provider.close();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.artifact).toEqual({
      path: fwPath,
      sha256: expectedSha256,
      bytes: image.length,
    });
    expect(res.value.vector_table_address).toBe("0x8020080");
    expect(res.value.reset_code_address).toBe("0x8020100");
    // Streamed in <= 64 KiB chunks and read only 16 * 4 + 4 = 68 bytes at offset 0x20080
    expect(maxBufferBytes).toBeLessThanOrEqual(65536);
    expect(positionalLengths).toEqual([68]);
  });

  it("returns typed resource, integrity, and cancellation failures", async () => {
    const dir = await createTestTempDirectory("rea-fw-vt-failures-");
    const fwPath = join(dir, "fw.bin");
    const image = Buffer.alloc(128, 0);
    image.writeUInt32LE(0x20010000, 0);
    image.writeUInt32LE(0x08000081, 4);
    await writeFile(fwPath, image);

    const provider = new FirmwareVectorTableProvider();

    // 1. max_file_bytes budget refusal
    const tooSmall = await provider.inspect(
      inspectFirmwareVectorTableInputSchema.parse({
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
        max_file_bytes: 32,
      }),
    );
    if (tooSmall.ok) throw new Error("Expected file-size refusal");
    expect(tooSmall.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(projectAnalysisError(tooSmall.error).details).toMatchObject({
      limit: {
        control_kind: "parameter",
        parameter: "max_file_bytes",
        effective_value: 32,
        unit: "bytes",
        applies_at: "next_call",
      },
    });

    // 2. max_svd_xml_nodes parameter budget refusal
    const tooManyNodes = await provider.inspect(
      inspectFirmwareVectorTableInputSchema.parse({
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
        svd_xml:
          "<device><peripherals><peripheral><name>TIM2</name><interrupt><name>TIM2</name><value>0</value></interrupt></peripheral></peripherals></device>",
        max_svd_xml_nodes: 3,
      }),
    );
    if (tooManyNodes.ok) throw new Error("Expected max_svd_xml_nodes refusal");
    expect(tooManyNodes.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(projectAnalysisError(tooManyNodes.error).details).toMatchObject({
      limit: {
        control_kind: "parameter",
        parameter: "max_svd_xml_nodes",
        effective_value: 3,
        unit: "count",
        applies_at: "next_call",
      },
    });

    // 3. max_svd_expanded_chars parameter budget refusal
    const longName = "U".repeat(128);
    const expandedRefusal = await provider.inspect(
      inspectFirmwareVectorTableInputSchema.parse({
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
        svd_xml: `<device><peripherals><peripheral><name>${longName}</name><interrupt><name>IRQ0</name><value>0</value></interrupt></peripheral></peripherals></device>`,
        max_svd_expanded_chars: 64,
      }),
    );
    if (expandedRefusal.ok)
      throw new Error("Expected max_svd_expanded_chars refusal");
    expect(expandedRefusal.error).toBeInstanceOf(
      AnalysisResourceConstraintError,
    );
    expect(projectAnalysisError(expandedRefusal.error).details).toMatchObject({
      limit: {
        control_kind: "parameter",
        parameter: "max_svd_expanded_chars",
        effective_value: 64,
        unit: "count",
        applies_at: "next_call",
      },
    });

    // 4. Caller cancellation preserves abort reason
    const abortReason = { reason: "caller-aborted-vector-read" };
    const cancelled = await provider.inspect(
      inspectFirmwareVectorTableInputSchema.parse({
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
      }),
      { signal: AbortSignal.abort(abortReason) },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error).toBeInstanceOf(AnalysisCancelledError);
    expect(cancelled.error.cause).toBe(abortReason);

    // 5. Short positional read at non-zero offset classifies as changed-target integrity failure
    const shortReadProvider = new FirmwareVectorTableProvider({
      fileSystem: {
        lstat: (path) => lstat(path, { bigint: true }),
        realpath,
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          const originalRead = handle.read.bind(handle);
          let streamed = false;
          handle.read = (async (
            buffer: Buffer,
            bufOffset?: number | null,
            length?: number | null,
            position?: number | bigint | null,
          ) => {
            const res = await originalRead(
              buffer,
              bufOffset ?? 0,
              length ?? buffer.length,
              position ?? null,
            );
            if (res.bytesRead === 0) streamed = true;
            else if (streamed && typeof position === "number" && position > 0) {
              return { bytesRead: 0, buffer };
            }
            return res;
          }) as typeof handle.read;
          return handle;
        },
      },
    });
    const integrityRes = await shortReadProvider.inspect(
      inspectFirmwareVectorTableInputSchema.parse({
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
        vector_table_offset: 64,
        max_entries: 8,
      }),
    );
    await shortReadProvider.close();
    await provider.close();
    if (integrityRes.ok) throw new Error("Expected read-coverage failure");
    expect(integrityRes.error).toBeInstanceOf(AnalysisArtifactChangedError);
  });
});
