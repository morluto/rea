import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createUefiAnalysisService } from "../../../src/application/ProviderOperationServices.js";
import { createUefiAnalysisProvider } from "../../../src/composition/uefi.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { buildFv } from "../../fixtures/uefiImage.js";

const selected = vi.hoisted(() => ({
  opened: undefined as ((path: unknown, file: FileHandle) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      selected.opened?.(args[0], file);
      return file;
    },
  };
});

afterEach(() => {
  selected.opened = undefined;
  vi.restoreAllMocks();
});

it.each([
  {
    stage: "denied close after verification",
    block: true,
    cancel: false,
    readFails: false,
  },
  {
    stage: "denied close with cancellation",
    block: true,
    cancel: true,
    readFails: false,
  },
  {
    stage: "successful close with cancellation",
    block: false,
    cancel: true,
    readFails: false,
  },
  {
    stage: "read denial before cancelled close",
    block: true,
    cancel: true,
    readFails: true,
  },
])(
  "preserves verified UEFI source facts through $stage",
  async ({ block, cancel, readFails }) => {
    const root = await createTestTempDirectory("rea-uefi-source-finalization-");
    const path = join(root, "selected.fd");
    const bytes = buildFv({ files: [] }).buffer;
    await writeFile(path, bytes);
    const operation = "inspect_uefi_firmware";
    const service = createUefiAnalysisService(createUefiAnalysisProvider());
    const controller = new AbortController();
    const cancelled = {
      reason: "cancelled while closing the selected firmware",
    };
    const denied = Object.assign(new Error("selected firmware read denied"), {
      code: "EACCES",
    });
    const opened: FileHandle[] = [];
    let denyClose = block;

    selected.opened = (openedPath, file) => {
      if (String(openedPath) !== path) return;
      opened.push(file);
      if (readFails) vi.spyOn(file, "read").mockRejectedValueOnce(denied);
      const close = file.close.bind(file);
      vi.spyOn(file, "close").mockImplementation(async () => {
        if (cancel) controller.abort(cancelled);
        if (denyClose) throw new Error("selected firmware close denied");
        await close();
      });
    };

    try {
      const result = await service.execute(
        operation,
        { path },
        { signal: controller.signal },
      );
      if (result.ok)
        throw new Error("Expected source finalization to interrupt inspection");
      const { error } = result;
      expect(error.cleanupIncomplete).toBe(block);
      expect(error.cleanupResources).toEqual(block ? [path] : []);
      if (readFails) {
        expect(error._tag).toBe("AnalysisAccessDeniedError");
        expect(error.cause).toBe(denied);
      } else if (cancel) {
        expect(error._tag).toBe("AnalysisCancelledError");
        expect(error.cause).toBe(cancelled);
      } else {
        expect(error).toMatchObject({
          _tag: "ProviderAdapterError",
          providerId: "rea-uefi",
          operation,
        });
      }
      const snapshot = readFails
        ? undefined
        : {
            kind: "file-snapshot-hash",
            path,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
      const details = projectAnalysisError(error).details;
      expect(details?.operation).toBe(operation);
      expect(details?.partial_observation).toEqual(snapshot);
      expect(opened).toHaveLength(1);
      if (block) {
        expect(opened[0]?.fd).toBeGreaterThanOrEqual(0);
        await expect(service.close()).rejects.toMatchObject({
          cleanup: { resources: [path] },
        });
        expect(error.cleanupResources).toEqual([path]);
      }
      denyClose = false;
      await service.close();
      expect(opened.map(({ fd }) => fd)).toEqual([-1]);
      expect(error.cleanupIncomplete).toBe(false);
      expect(error.cleanupResources).toEqual([]);
      expect(error.partialObservation).toEqual(snapshot);
    } finally {
      denyClose = false;
      await service.close();
    }
  },
);
