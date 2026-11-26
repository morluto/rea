import { describe, expect, it } from "vitest";
import { FIRMWARE_LITERAL_POOLS_PROVIDER } from "../../domain/investigationProviders.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import { firmwareLiteralPoolBudgetLimit } from "../../domain/firmware/firmwareLiteralPools.js";
import { err, ok } from "../../domain/result.js";
import type { FirmwareLiteralPoolsPort } from "../../ports/binaryDiagnostics/FirmwareLiteralPoolsPort.js";
import { FirmwareLiteralPoolsService } from "./FirmwareLiteralPoolsService.js";

describe("FirmwareLiteralPoolsService", () => {
  it("records sha256-bound Evidence, file-offset-range location, caller-only parameters, and hashed svd_xml provenance", async () => {
    const mockPort: FirmwareLiteralPoolsPort = {
      identity: FIRMWARE_LITERAL_POOLS_PROVIDER,
      inspect: async (input) =>
        ok({
          artifact: {
            path: input.path,
            sha256: "d".repeat(64),
            bytes: 256,
          },
          isa: input.isa,
          base_address: "0x8000000",
          scan_range: { start: 32, end: 160, scanned_bytes: 128 },
          coverage: {
            status: "complete",
            available_from_offset_bytes: 128,
            retained_references: 0,
            omitted_references: 0,
          },
          counts: {
            resolved_pool_loads: 0,
            distinct_pool_slots: 0,
            mmio_pool_loads: 0,
            out_of_image_pool_targets: 0,
            suppressed_pool_slot_overlaps: 0,
          },
          svd_profile: {
            supplied: true,
            peripheral_count: 1,
            matched_load_count: 0,
          },
          mmio_summary: [],
          references: [],
          limitations: ["Linear scan scope."],
        }),
    };

    const service = new FirmwareLiteralPoolsService(mockPort);
    const res = await service.inspect({
      path: "/tmp/stm32_app.bin",
      isa: "arm-thumb",
      base_address: "0x08000000",
      scan_offset: 32,
      svd_xml: "<device><peripherals/></device>",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.operation).toBe("inspect_firmware_literal_pools");
    expect(res.value.subject.identity).toMatchObject({
      kind: "file",
      sha256: "d".repeat(64),
    });
    expect(Object.keys(res.value.parameters).sort()).toEqual([
      "base_address",
      "isa",
      "path",
      "scan_offset",
      "svd_xml_sha256",
    ]);
    expect(res.value.locations).toEqual([
      { kind: "artifact-path", path: "/tmp/stm32_app.bin" },
      { kind: "file-offset-range", start: 32, end: 160 },
    ]);
  });

  it("rejects misaligned base_address before provider execution and propagates parameter budget refusals", async () => {
    let providerCalled = false;
    const mockPort: FirmwareLiteralPoolsPort = {
      identity: FIRMWARE_LITERAL_POOLS_PROVIDER,
      inspect: async (input) => {
        providerCalled = true;
        return err(
          parseLimitConstraint(
            "inspect_firmware_literal_pools",
            "capacity",
            decodeLimit("cmsis-svd", "svd_xml exceeded max_svd_nodes", {
              name: "max_svd_nodes",
              maximum: input.max_svd_nodes,
            }),
            {
              retryable: false,
              limit: firmwareLiteralPoolBudgetLimit(
                "max_svd_nodes",
                input.max_svd_nodes,
              ),
              remediationAction: "Raise max_svd_nodes.",
            },
          ),
        );
      },
    };

    const service = new FirmwareLiteralPoolsService(mockPort);
    const badAlign = await service.inspect({
      path: "/tmp/stm32_app.bin",
      isa: "arm-thumb",
      base_address: "0x08000001",
    });
    expect(badAlign.ok).toBe(false);
    expect(providerCalled).toBe(false);
    if (!badAlign.ok) {
      expect(badAlign.error._tag).toBe("AnalysisInputError");
    }

    const limitRes = await service.inspect({
      path: "/tmp/stm32_app.bin",
      isa: "arm-thumb",
      base_address: "0x08000000",
      svd_xml: "<device/>",
      max_svd_nodes: 32,
    });
    expect(limitRes.ok).toBe(false);
    if (!limitRes.ok) {
      expect(limitRes.error.limit).toMatchObject({
        control_kind: "parameter",
        parameter: "max_svd_nodes",
        effective_value: 32,
      });
    }
  });
});
