import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  controller: undefined as AbortController | undefined,
  reason: undefined as unknown,
}));

vi.mock("../../src/process/ExecFileOutput.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/process/ExecFileOutput.js")
    >();
  return {
    ...actual,
    execFileOutput: vi.fn(async () => {
      state.controller?.abort(state.reason);
      throw new actual.ExecFileOutputCancelledError(state.reason);
    }),
  };
});

import { execFileOutput } from "../../src/process/ExecFileOutput.js";
import { ArtifactReaderFailure } from "../../src/artifacts/ArtifactReader.js";
import { DirectoryArtifactReader } from "../../src/artifacts/DirectoryArtifactReader.js";
import { analyzeAppleAssetCatalogs } from "../../src/artifacts/apple/AppleAssetCatalogAnalysis.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const canSimulateDarwin =
  process.platform === "darwin" || platformDescriptor?.configurable === true;

/** Run the macOS-only catalog path on non-macOS CI without changing production behavior. */
const withDarwinPlatform = async <T>(run: () => Promise<T>): Promise<T> => {
  if (process.platform === "darwin") return run();
  if (platformDescriptor?.configurable !== true)
    throw new Error("This host cannot simulate the macOS catalog gate");
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "darwin",
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
};

const createBundle = async (): Promise<string> => {
  const bundle = await createTestTempDirectory(
    "rea-asset-catalog-cancellation-",
  );
  await mkdir(join(bundle, "Contents", "Resources"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Resources", "Assets.car"),
    "inert catalog fixture",
  );
  return bundle;
};

const analyze = (bundle: string, signal: AbortSignal) =>
  analyzeAppleAssetCatalogs({
    bundlePath: bundle,
    targetSha256: null,
    environment: {},
    signal,
    analyzeInterfaceBuilder: (async () => ({
      graph: { nodes: [], truncated: false },
    })) as never,
  });

it.skipIf(!canSimulateDarwin)(
  "retains the caller reason when assetutil observes cancellation",
  async () => {
    vi.mocked(execFileOutput).mockClear();
    const bundle = await createBundle();
    const reason = { requested: "stop asset catalog" };
    const controller = new AbortController();
    state.controller = controller;
    state.reason = reason;
    try {
      const failure: unknown = await withDarwinPlatform(() =>
        analyze(bundle, controller.signal),
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("Expected asset catalog cancellation");
      expect(execFileOutput).toHaveBeenCalledTimes(1);
      expect(failure.reason).toBe("cancelled");
      expect(failure.cancellation?.reason).toBe(reason);
    } finally {
      await rm(bundle, { recursive: true, force: true });
    }
  },
);

it.skipIf(!canSimulateDarwin)(
  "retains the caller reason when the catalog digest is cancelled",
  async () => {
    vi.mocked(execFileOutput).mockClear();
    const bundle = await createBundle();
    const reason = { requested: "stop during catalog digest" };
    const controller = new AbortController();
    state.controller = controller;
    state.reason = reason;
    let readEntered = false;
    const open = vi
      .spyOn(DirectoryArtifactReader.prototype, "open")
      .mockImplementationOnce(
        async () =>
          new Readable({
            read() {
              readEntered = true;
              this.push(Buffer.from("inert catalog fixture"));
              controller.abort(reason);
              this.push(null);
            },
          }),
      );
    try {
      const failure: unknown = await withDarwinPlatform(() =>
        analyze(bundle, controller.signal),
      ).catch((cause: unknown) => cause);
      expect(readEntered).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe(reason);
      expect(execFileOutput).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("Expected asset catalog digest cancellation");
      expect(failure.reason).toBe("cancelled");
      expect(failure.cancellation?.reason).toBe(reason);
    } finally {
      open.mockRestore();
      await rm(bundle, { recursive: true, force: true });
    }
  },
);
