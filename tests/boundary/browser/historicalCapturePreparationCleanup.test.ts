import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as inspection from "../../../src/process/DarwinProcessRunTokenReader.js";
import * as ownership from "../../../src/process/ProcessOwnershipObservation.js";
import { HistoricalCaptureDecoder } from "../../../src/browser/history/HistoricalCaptureDecoder.js";
import { WebNetworkCaptureService } from "../../../src/application/WebNetworkCaptureService.js";
import { HAR_CAPTURE_PROVIDER_IDENTITY } from "../../../src/browser/history/CaptureProviderIdentities.js";
import { inspectWebNetworkCaptureInputSchema } from "../../../src/domain/webNetworkCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { historicalHar } from "../../fixtures/historicalHar.js";
import { primaryAnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { failedInspectionDescriptor } from "../../fixtures/processInspectionCleanup.js";

const adapter = {
  format: "har" as const,
  identity: HAR_CAPTURE_PROVIDER_IDENTITY,
  command: async () => ({
    command: process.execPath,
    arguments: ["-e", "process.exit(0)"],
  }),
};

it.each(["descriptor", "compiler", "cancelled"] as const)(
  "retains %s preparation cleanup across capture failure, admission and close",
  async (kind) => {
    const root = await createTestTempDirectory(
      "rea-capture-preparation-owner-",
    );
    const path = join(root, "capture.har");
    await writeFile(path, JSON.stringify(historicalHar()));
    const file = await failedInspectionDescriptor(root);
    const failure =
      kind === "descriptor"
        ? file.failure
        : new inspection.DarwinProcessOwnershipInspectionError(
            "ownership preparation fixture",
            {
              cleanupOwner: file.failure.owner,
              ...(kind === "cancelled"
                ? { cancellation: { reason: "preparation stopped" } }
                : {}),
            },
          );
    const prepare = vi
      .spyOn(ownership, "prepareProcessOwnershipInspection")
      .mockRejectedValue(failure);
    const removed: string[] = [];
    let roots = 0;
    const createRuntime = vi.fn(async () => {
      const path = join(root, `runtime-${roots++}`);
      await mkdir(path);
      return {
        path,
        close: async () => {
          removed.push(path);
          await rm(path, { recursive: true });
        },
      };
    });
    const decoder = new HistoricalCaptureDecoder([adapter], {}, createRuntime);
    const service = new WebNetworkCaptureService(decoder);
    const input = inspectWebNetworkCaptureInputSchema.parse({
      capture_path: path,
      format: "har",
    });
    try {
      const first = await service.inspect(input);
      if (first.ok) throw new Error("Expected preparation failure");
      await file.handle.stat();
      expect({
        cleanupIncomplete: first.error.cleanupIncomplete,
        removed,
        descriptorOpen: file.handle.fd >= 0,
      }).toEqual({
        cleanupIncomplete: true,
        removed: [],
        descriptorOpen: true,
      });
      if (kind === "cancelled")
        expect(primaryAnalysisError(first.error).cause).toBe(
          "preparation stopped",
        );
      expect(removed).toEqual([]);
      await file.handle.stat();

      const blocked = await service.inspect(input);
      expect(blocked.ok).toBe(false);
      expect(createRuntime).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(file.closes()).toBe(2);

      await expect(service.close()).rejects.toThrow();
      expect(removed).toEqual([]);
      await file.handle.stat();
      file.allow();
      await service.close();
      expect(file.closes()).toBe(4);
      expect(removed).toHaveLength(1);
      await expect(file.handle.stat()).rejects.toMatchObject({ code: "EBADF" });
      expect(first.error.cleanupIncomplete).toBe(false);
    } finally {
      file.allow();
      try {
        await service.close();
      } finally {
        prepare.mockRestore();
      }
    }
  },
);

it("does not adopt a native cleanup capability carried only as an opaque caller abort reason", async () => {
  const file = await failedInspectionDescriptor();
  const reason = new inspection.DarwinProcessOwnershipInspectionError(
    "opaque caller reason",
    { cleanupOwner: file.failure.owner },
  );
  const controller = new AbortController();
  const createRuntime = vi.fn(async () => {
    const path = await createTestTempDirectory("rea-capture-opaque-abort-");
    return { path, close: () => rm(path, { recursive: true }) };
  });
  const decoder = new HistoricalCaptureDecoder(
    [
      {
        ...adapter,
        command: async () => {
          controller.abort(reason);
          return adapter.command();
        },
      },
    ],
    {},
    createRuntime,
  );
  const service = new WebNetworkCaptureService(decoder);
  try {
    const result = await service.inspect(
      inspectWebNetworkCaptureInputSchema.parse({
        capture_path: file.path,
        format: "har",
      }),
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(primaryAnalysisError(result.error).cause).toBe(reason);
    expect(result.error.cleanupIncomplete).toBe(false);
    await service.close();
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(file.closes()).toBe(1);
    await file.handle.stat();
  } finally {
    await service.close();
  }
});
