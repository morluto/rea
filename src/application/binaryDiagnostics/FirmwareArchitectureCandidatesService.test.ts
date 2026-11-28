import { describe, expect, it } from "vitest";
import { FirmwareArchitectureCandidatesService } from "./FirmwareArchitectureCandidatesService.js";
import type { FirmwareArchitectureCandidatesPort } from "../../ports/binaryDiagnostics/FirmwareArchitectureCandidatesPort.js";
import { FIRMWARE_ARCHITECTURE_CANDIDATES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  firmwareArchBudgetLimit,
  firmwareArchitectureCandidatesSchema,
} from "../../domain/firmware/firmwareArchitectureCandidates.js";
import { scanFirmwareArchitectureCandidates } from "../../domain/firmware/firmwareArchitectureScanner.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import { err, ok } from "../../domain/result.js";
import { buildUImage } from "../../../tests/fixtures/uimage.js";

describe("FirmwareArchitectureCandidatesService", () => {
  it("produces digest-bound Evidence with file-offset locations and partial scan coverage", async () => {
    const uimage = buildUImage({
      arch: 22, // arm64
      compression: 1, // gzip
      loadAddress: 0x40080000,
      entryPoint: 0x40080000,
      payload: Buffer.alloc(256, 0xaa),
    });
    const fullBytes = Buffer.concat([uimage, Buffer.alloc(512, 0xff)]);

    const port: FirmwareArchitectureCandidatesPort = {
      identity: FIRMWARE_ARCHITECTURE_CANDIDATES_PROVIDER,
      inspect: async (input) =>
        ok(
          await scanFirmwareArchitectureCandidates({
            artifact: {
              path: input.path,
              sha256: "a".repeat(64),
              bytes: fullBytes.length,
            },
            prefixBytes: fullBytes.subarray(0, input.max_scan_bytes),
          }),
        ),
    };

    const service = new FirmwareArchitectureCandidatesService(port);
    const result = await service.inspect({
      path: "/artifacts/uimage-padded.bin",
      max_scan_bytes: 128,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.operation).toBe(
      "inspect_firmware_architecture_candidates",
    );
    expect(result.value.parameters).toEqual({
      path: "/artifacts/uimage-padded.bin",
      max_scan_bytes: 128,
    });
    expect(result.value.confidence).toBe("derived");
    const parsed = firmwareArchitectureCandidatesSchema.parse(
      result.value.normalized_result,
    );
    expect(parsed.coverage.status).toBe("partial");
    expect(parsed.coverage.examined_bytes).toBe(128);
    expect(parsed.candidates[0]?.cpu_family).toBe("arm64");
    expect(result.value.locations).toContainEqual({
      kind: "file-offset-range",
      start: 0,
      end: 64,
    });
  });

  it("retains completed Evidence and caller selections on late cancellation", async () => {
    const uimage = buildUImage({
      arch: 2, // arm
      compression: 0,
      loadAddress: 0x80008000,
      entryPoint: 0x80008000,
      payload: Buffer.alloc(64, 0),
    });
    const controller = new AbortController();
    const port: FirmwareArchitectureCandidatesPort = {
      identity: FIRMWARE_ARCHITECTURE_CANDIDATES_PROVIDER,
      inspect: async (input) => {
        const report = await scanFirmwareArchitectureCandidates({
          artifact: {
            path: input.path,
            sha256: "b".repeat(64),
            bytes: uimage.length,
          },
          prefixBytes: uimage,
        });
        controller.abort("caller-late-cancel");
        return ok(report);
      },
    };

    const service = new FirmwareArchitectureCandidatesService(port);
    const result = await service.inspect(
      { path: "/artifacts/late-cancel.uimage" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe("caller-late-cancel");
    expect(result.error.partialObservation).toMatchObject({
      operation: "inspect_firmware_architecture_candidates",
      parameters: { path: "/artifacts/late-cancel.uimage" },
    });
  });

  it("preserves typed parameter limit recovery when provider reports max_file_bytes exhaustion", async () => {
    const port: FirmwareArchitectureCandidatesPort = {
      identity: FIRMWARE_ARCHITECTURE_CANDIDATES_PROVIDER,
      inspect: async (input) =>
        err(
          parseLimitConstraint(
            "inspect_firmware_architecture_candidates",
            "file-size",
            decodeLimit("firmware-architecture-candidates", "exceeds budget", {
              name: "max_file_bytes",
              maximum: input.max_file_bytes,
            }),
            {
              retryable: false,
              limit: firmwareArchBudgetLimit(
                "max_file_bytes",
                input.max_file_bytes,
              ),
              remediationAction: "Raise max_file_bytes.",
            },
          ),
        ),
    };

    const service = new FirmwareArchitectureCandidatesService(port);
    const result = await service.inspect({
      path: "/artifacts/oversized.bin",
      max_file_bytes: 32,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
    expect(result.error.limit).toMatchObject({
      control_kind: "parameter",
      parameter: "max_file_bytes",
      effective_value: 32,
      applies_at: "next_call",
    });
  });
});
