import { createHash } from "node:crypto";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTargetFailureError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { inspectFirmwareVectorTableInputSchema } from "../../domain/firmware/firmwareVectorTable.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { FirmwareVectorTableProvider } from "./FirmwareVectorTableProvider.js";
import {
  analysisRefusalRemediation,
  type AdjustableBudget,
} from "../../domain/analysisRefusal.js";

/** The delivered recovery is the shared refusal formatter applied to the reported limit. */
const formattedRecovery = (projected: { readonly details?: unknown }): string =>
  analysisRefusalRemediation({
    kind: "adjustable_budget",
    operation: "inspect_firmware_vector_table",
    budget: (projected.details as { readonly limit: AdjustableBudget }).limit,
  });

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
    if (
      tooSmall.ok ||
      !(tooSmall.error instanceof AnalysisResourceConstraintError)
    )
      throw new Error("Expected file-size refusal");
    expect(tooSmall.error.remediationAction).toBeUndefined();
    const projectedTooSmall = projectAnalysisError(tooSmall.error);
    expect(projectedTooSmall.remediation.action).toBe(
      formattedRecovery(projectedTooSmall),
    );
    expect(projectedTooSmall.details).toMatchObject({
      limit: {
        control_kind: "parameter",
        parameter: "max_file_bytes",
        effective_value: 32,
        required_value: 128,
        unit: "bytes",
        applies_at: "next_call",
      },
      refusal: {
        kind: "adjustable_budget",
        operation: "inspect_firmware_vector_table",
        control: "max_file_bytes",
        effective_value: 32,
        required_value: 128,
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
    if (
      tooManyNodes.ok ||
      !(tooManyNodes.error instanceof AnalysisResourceConstraintError)
    )
      throw new Error("Expected max_svd_xml_nodes refusal");
    expect(tooManyNodes.error.remediationAction).toBeUndefined();
    const projectedNodes = projectAnalysisError(tooManyNodes.error);
    expect(projectedNodes.remediation.action).toBe(
      formattedRecovery(projectedNodes),
    );
    expect(projectedNodes.details).toMatchObject({
      limit: {
        control_kind: "parameter",
        parameter: "max_svd_xml_nodes",
        effective_value: 3,
        unit: "count",
        applies_at: "next_call",
      },
      refusal: {
        kind: "adjustable_budget",
        operation: "inspect_firmware_vector_table",
        control: "max_svd_xml_nodes",
        effective_value: 3,
      },
    });

    // 3. max_svd_expanded_chars parameter budget refusal (valid and rejected SVD declarations)
    const longName = "U".repeat(128);
    for (const svdXml of [
      `<device><peripherals><peripheral><name>${longName}</name><interrupt><name>IRQ0</name><value>0</value></interrupt></peripheral></peripherals></device>`,
      `<device><peripherals><peripheral><name>${longName}</name><interrupt><value>0</value></interrupt></peripheral></peripherals></device>`,
    ]) {
      const expandedRefusal = await provider.inspect(
        inspectFirmwareVectorTableInputSchema.parse({
          path: fwPath,
          architecture: "armv7-m",
          base_address: "0x08000000",
          svd_xml: svdXml,
          max_svd_expanded_chars: 64,
        }),
      );
      if (
        expandedRefusal.ok ||
        !(expandedRefusal.error instanceof AnalysisResourceConstraintError)
      )
        throw new Error("Expected max_svd_expanded_chars refusal");
      expect(expandedRefusal.error.remediationAction).toBeUndefined();
      const projectedExpanded = projectAnalysisError(expandedRefusal.error);
      expect(projectedExpanded.remediation.action).toBe(
        formattedRecovery(projectedExpanded),
      );
      expect(projectedExpanded.details).toMatchObject({
        limit: {
          control_kind: "parameter",
          parameter: "max_svd_expanded_chars",
          effective_value: 64,
          unit: "count",
          applies_at: "next_call",
        },
        refusal: {
          kind: "adjustable_budget",
          operation: "inspect_firmware_vector_table",
          control: "max_svd_expanded_chars",
          effective_value: 64,
        },
      });
    }

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

  it("attributes rejected svd_xml, out-of-file vector_table_offset, and address overflow to caller inputs while keeping short images at offset 0 as target failures", async () => {
    const dir = await createTestTempDirectory("rea-fw-vt-inputs-");
    const fwPath = join(dir, "fw.bin");
    const shortPath = join(dir, "short.bin");
    const image = Buffer.alloc(128, 0);
    image.writeUInt32LE(0x20010000, 0);
    image.writeUInt32LE(0x08000081, 4);
    await writeFile(fwPath, image);
    await writeFile(shortPath, Buffer.alloc(4, 0));

    const provider = new FirmwareVectorTableProvider();

    // 1. Rejected svd_xml (<wrong/> or DOCTYPE) blames svd_xml, not fwPath
    for (const badSvd of [
      "<wrong/>",
      '<!DOCTYPE device SYSTEM "x.dtd"><device/>',
    ]) {
      const svdRes = await provider.inspect(
        inspectFirmwareVectorTableInputSchema.parse({
          path: fwPath,
          architecture: "armv7-m",
          base_address: "0x08000000",
          svd_xml: badSvd,
        }),
      );
      if (svdRes.ok || !(svdRes.error instanceof AnalysisInputError))
        throw new Error("Expected svd_xml AnalysisInputError");
      const projected = projectAnalysisError(svdRes.error);
      expect(projected.code).toBe("invalid_request");
      expect(projected.category).toBe("invalid_input");
      expect(projected.remediation.action).toContain("svd_xml");
      expect(projected.details).toMatchObject({
        operation: "inspect_firmware_vector_table",
        issues: [{ path: ["svd_xml"], reason: "invalid_format" }],
        related_parameters: ["svd_xml"],
      });
    }

    // 2. Out-of-file vector_table_offset blames vector_table_offset with valid bounds
    const offsetRes = await provider.inspect(
      inspectFirmwareVectorTableInputSchema.parse({
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
        vector_table_offset: 124,
      }),
    );
    if (offsetRes.ok || !(offsetRes.error instanceof AnalysisInputError))
      throw new Error("Expected vector_table_offset AnalysisInputError");
    const projectedOffset = projectAnalysisError(offsetRes.error);
    expect(projectedOffset.code).toBe("invalid_request");
    expect(projectedOffset.remediation.action).toContain(
      "Pass a 4-byte aligned vector_table_offset between 0 and 120",
    );
    expect(projectedOffset.details).toMatchObject({
      issues: [
        {
          path: ["vector_table_offset"],
          reason: "out_of_range",
          maximum: 120,
        },
      ],
      related_parameters: ["vector_table_offset"],
    });

    // 3. base_address + vector_table_offset overflowing 32-bit address space blames caller inputs
    const overflowRes = await provider.inspect(
      inspectFirmwareVectorTableInputSchema.parse({
        path: fwPath,
        architecture: "riscv",
        base_address: "0xfffffff8",
        vector_table_offset: 16,
      }),
    );
    if (overflowRes.ok || !(overflowRes.error instanceof AnalysisInputError))
      throw new Error("Expected overflow AnalysisInputError");
    expect(projectAnalysisError(overflowRes.error).details).toMatchObject({
      issues: [{ path: ["vector_table_offset"], reason: "out_of_range" }],
      related_parameters: ["base_address", "vector_table_offset"],
    });

    // 4. Too-short image at default offset 0 remains a malformed target failure
    const shortRes = await provider.inspect(
      inspectFirmwareVectorTableInputSchema.parse({
        path: shortPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
      }),
    );
    await provider.close();
    if (shortRes.ok) throw new Error("Expected short target failure");
    expect(shortRes.error).toBeInstanceOf(AnalysisTargetFailureError);
  });
});
