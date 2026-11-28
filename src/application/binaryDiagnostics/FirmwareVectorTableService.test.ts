import { describe, expect, it } from "vitest";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { FirmwareVectorTableService } from "./FirmwareVectorTableService.js";
import { FIRMWARE_VECTOR_TABLE_PROVIDER } from "../../domain/investigationProviders.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import {
  firmwareVectorBudgetLimit,
  type FirmwareVectorTable,
} from "../../domain/firmware/firmwareVectorTable.js";
import { err, ok } from "../../domain/result.js";
import type { FirmwareVectorTablePort } from "../../ports/binaryDiagnostics/FirmwareVectorTablePort.js";

const sampleArmReport = (
  path: string,
  vectorTableOffset: number,
): FirmwareVectorTable => ({
  artifact: {
    path,
    sha256: "e".repeat(64),
    bytes: 256,
  },
  architecture: "armv7-m",
  base_address: "0x8000000",
  vector_table_offset: vectorTableOffset,
  vector_table_address: `0x${(0x08000000 + vectorTableOffset).toString(16)}`,
  vtor_aligned: vectorTableOffset % 128 === 0,
  examined_entries: 4,
  table_file_range: { start: vectorTableOffset, end: vectorTableOffset + 16 },
  coverage: {
    status: "partial",
    examined_bytes: 16,
    available_from_offset_bytes: 256 - vectorTableOffset,
  },
  initial_stack_pointer: "0x20010000",
  reset_code_address: "0x8000100",
  trap_entry_address: null,
  riscv_table_shape: null,
  arm_entries: [],
  active_arm_entry_count: 0,
  riscv_slots: [],
  recognized_riscv_slot_count: 0,
  shared_handler_groups: [],
  svd_interrupts: {
    supplied: true,
    mapped_irq_count: 0,
    ambiguous_irq_count: 0,
    unmapped_active_irq_count: 0,
  },
  anomalies: [],
  limitations: ["Decoded 4 slots up to max_entries."],
});

describe("FirmwareVectorTableService", () => {
  it("refuses a provider report whose stored slot counts disagree with its slots", async () => {
    const mockPort: FirmwareVectorTablePort = {
      identity: FIRMWARE_VECTOR_TABLE_PROVIDER,
      inspect: async (input) =>
        ok({
          ...sampleArmReport(input.path, input.vector_table_offset),
          active_arm_entry_count: 1,
        }),
    };
    const res = await new FirmwareVectorTableService(mockPort).inspect({
      path: "/tmp/stm32.bin",
      architecture: "armv7-m",
      base_address: "0x08000000",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain("malformed output");
  });

  it("records sha256-bound Evidence, file-offset-range location, hashed svd_xml provenance, and omits defaulted controls", async () => {
    const mockPort: FirmwareVectorTablePort = {
      identity: FIRMWARE_VECTOR_TABLE_PROVIDER,
      inspect: async (input) =>
        ok(sampleArmReport(input.path, input.vector_table_offset)),
    };

    const service = new FirmwareVectorTableService(mockPort);
    const res = await service.inspect({
      path: "/tmp/stm32.bin",
      architecture: "armv7-m",
      base_address: "0x08000000",
      svd_xml: "<device><peripherals/></device>",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.operation).toBe("inspect_firmware_vector_table");
    expect(res.value.subject.identity).toMatchObject({
      kind: "file",
      sha256: "e".repeat(64),
    });
    expect(res.value.parameters).toEqual({
      path: "/tmp/stm32.bin",
      architecture: "armv7-m",
      base_address: "0x08000000",
      svd_xml_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(res.value.locations).toEqual([
      { kind: "artifact-path", path: "/tmp/stm32.bin" },
      { kind: "file-offset-range", start: 0, end: 16 },
    ]);
    expect(res.value.limitations).toEqual([
      "Decoded 4 slots up to max_entries.",
      "Inline svd_xml UTF-8 text is not retained in Evidence and is unavailable from this record; parameters.svd_xml_sha256 records the SHA-256 digest of the caller-supplied svd_xml.",
    ]);

    const withoutSvd = await service.inspect({
      path: "/tmp/stm32.bin",
      architecture: "armv7-m",
      base_address: "0x08000000",
    });
    expect(withoutSvd.ok).toBe(true);
    if (!withoutSvd.ok) return;
    expect(withoutSvd.value.limitations).toEqual([
      "Decoded 4 slots up to max_entries.",
    ]);
  });

  it("retains completed Evidence and caller selections on late cancellation", async () => {
    const controller = new AbortController();
    const reason = { source: "vector table completion" };
    const report = sampleArmReport("/tmp/stm32.bin", 0);
    const service = new FirmwareVectorTableService({
      identity: FIRMWARE_VECTOR_TABLE_PROVIDER,
      inspect: async () => {
        controller.abort(reason);
        return ok(report);
      },
    });

    const result = await service.inspect(
      {
        path: "/tmp/stm32.bin",
        architecture: "armv7-m",
        base_address: "0x08000000",
      },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected late cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toMatchObject({
      operation: "inspect_firmware_vector_table",
      parameters: {
        path: "/tmp/stm32.bin",
        architecture: "armv7-m",
        base_address: "0x08000000",
      },
      normalized_result: report,
    });
  });

  it("propagates parameter limit refusals with control_kind: parameter", async () => {
    const mockPort: FirmwareVectorTablePort = {
      identity: FIRMWARE_VECTOR_TABLE_PROVIDER,
      inspect: async (input) =>
        err(
          parseLimitConstraint(
            "inspect_firmware_vector_table",
            "file-size",
            decodeLimit(
              "firmware-vector-table",
              "File exceeds max_file_bytes",
              {
                name: "max_file_bytes",
                maximum: input.max_file_bytes,
              },
            ),
            {
              retryable: false,
              limit: firmwareVectorBudgetLimit(
                "max_file_bytes",
                input.max_file_bytes,
              ),
            },
          ),
        ),
    };
    const service = new FirmwareVectorTableService(mockPort);
    const res = await service.inspect({
      path: "/tmp/huge.bin",
      architecture: "armv7-m",
      base_address: "0x08000000",
      max_file_bytes: 16,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.limit).toMatchObject({
      control_kind: "parameter",
      parameter: "max_file_bytes",
      effective_value: 16,
    });
  });
});
