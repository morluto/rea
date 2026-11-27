import { describe, expect, it } from "vitest";
import { EspNvsService } from "./EspNvsService.js";
import { ESP_NVS_PROVIDER } from "../../domain/investigationProviders.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import { espNvsBudgetLimit } from "../../domain/firmware/espNvs.js";
import { err, ok } from "../../domain/result.js";
import type { EspNvsPort } from "../../ports/binaryDiagnostics/EspNvsPort.js";

describe("EspNvsService", () => {
  it("wraps NVS report in sha256-bound Evidence with caller-selected parameters only", async () => {
    const mockPort: EspNvsPort = {
      identity: ESP_NVS_PROVIDER,
      inspect: async (input) =>
        ok({
          artifact: {
            path: input.path,
            sha256: "c".repeat(64),
            bytes: 65536,
          },
          partition_range: {
            start: 36864,
            end: 45056,
            page_count: 2,
            trailing_unaligned_bytes: 0,
          },
          coverage: {
            status: "complete",
            examined_pages: 2,
            retained_entries: 0,
            omitted_entries: 0,
          },
          pages: [],
          namespaces: [],
          entries: [],
          corrupt_entry_count: 0,
          undecoded_page_count: 0,
          anomalies: [],
          limitations: [],
        }),
    };

    const service = new EspNvsService(mockPort);
    const res = await service.inspect({
      path: "/tmp/flash.bin",
      partition_offset: 36864,
      partition_bytes: 8192,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.operation).toBe("inspect_esp_nvs");
    expect(res.value.parameters).toEqual({
      path: "/tmp/flash.bin",
      partition_offset: 36864,
      partition_bytes: 8192,
    });
    expect(res.value.subject.identity).toMatchObject({
      kind: "file",
      sha256: "c".repeat(64),
    });
    expect(res.value.locations).toEqual([
      { kind: "artifact-path", path: "/tmp/flash.bin" },
      { kind: "file-offset-range", start: 36864, end: 45056 },
    ]);
  });

  it("propagates max_file_bytes refusals with control_kind: parameter", async () => {
    const mockPort: EspNvsPort = {
      identity: ESP_NVS_PROVIDER,
      inspect: async (input) =>
        err(
          parseLimitConstraint(
            "inspect_esp_nvs",
            "file-size",
            decodeLimit("esp-nvs", "File exceeds max_file_bytes", {
              name: "max_file_bytes",
              maximum: input.max_file_bytes,
            }),
            {
              retryable: false,
              limit: espNvsBudgetLimit("max_file_bytes", input.max_file_bytes),
              remediationAction: "Raise max_file_bytes.",
            },
          ),
        ),
    };
    const service = new EspNvsService(mockPort);
    const res = await service.inspect({
      path: "/tmp/big_flash.bin",
      max_file_bytes: 4096,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.limit).toMatchObject({
      control_kind: "parameter",
      parameter: "max_file_bytes",
      effective_value: 4096,
    });
  });

  it("rejects a provider report whose partition_range is shorter than requested partition_bytes", async () => {
    const mockPort: EspNvsPort = {
      identity: ESP_NVS_PROVIDER,
      inspect: async (input) =>
        ok({
          artifact: {
            path: input.path,
            sha256: "f".repeat(64),
            bytes: 8192,
          },
          partition_range: {
            start: 0,
            end: 8192,
            page_count: 2,
            trailing_unaligned_bytes: 0,
          },
          coverage: {
            status: "complete",
            examined_pages: 2,
            retained_entries: 0,
            omitted_entries: 0,
          },
          pages: [],
          namespaces: [],
          entries: [],
          corrupt_entry_count: 0,
          undecoded_page_count: 0,
          anomalies: [],
          limitations: [],
        }),
    };
    const service = new EspNvsService(mockPort);
    const res = await service.inspect({
      path: "/tmp/two_pages.bin",
      partition_offset: 0,
      partition_bytes: 12288,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error._tag).toBe("AnalysisOutputError");
  });

  it("honors cancellation before reading and retains completed Evidence on late cancellation", async () => {
    let providerCalled = false;
    const preAborted = new AbortController();
    preAborted.abort("stop-before-read");

    const service = new EspNvsService({
      identity: ESP_NVS_PROVIDER,
      inspect: async () => {
        providerCalled = true;
        throw new Error("should not run");
      },
    });
    const early = await service.inspect(
      { path: "/tmp/nvs.bin" },
      { signal: preAborted.signal },
    );
    expect(providerCalled).toBe(false);
    expect(early.ok).toBe(false);
    if (!early.ok) {
      expect(early.error._tag).toBe("AnalysisCancelledError");
    }

    const lateAbort = new AbortController();
    const lateService = new EspNvsService({
      identity: ESP_NVS_PROVIDER,
      inspect: async (input) => {
        lateAbort.abort("stop-as-provider-completes");
        return ok({
          artifact: {
            path: input.path,
            sha256: "e".repeat(64),
            bytes: 4096,
          },
          partition_range: {
            start: 0,
            end: 4096,
            page_count: 1,
            trailing_unaligned_bytes: 0,
          },
          coverage: {
            status: "complete",
            examined_pages: 1,
            retained_entries: 0,
            omitted_entries: 0,
          },
          pages: [],
          namespaces: [],
          entries: [],
          corrupt_entry_count: 0,
          undecoded_page_count: 0,
          anomalies: [],
          limitations: [],
        });
      },
    });
    const late = await lateService.inspect(
      { path: "/tmp/nvs.bin" },
      { signal: lateAbort.signal },
    );
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.error._tag).toBe("AnalysisCancelledError");
    expect(late.error.partialObservation).toMatchObject({
      operation: "inspect_esp_nvs",
      parameters: { path: "/tmp/nvs.bin" },
      subject: {
        identity: { kind: "file", sha256: "e".repeat(64) },
      },
    });
  });
});
