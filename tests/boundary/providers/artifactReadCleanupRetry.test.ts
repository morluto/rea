import type { FileHandle } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const cleanupState = vi.hoisted(() => ({
  failFirstClose: false,
  abortController: undefined as AbortController | undefined,
  firstHandle: undefined as FileHandle | undefined,
  firstHandleCloseAttempts: 0,
}));

const openedFirstHandle = (): FileHandle => {
  const handle = cleanupState.firstHandle;
  if (handle === undefined) throw new Error("Missing admitted descriptor");
  return handle;
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const close = handle.close.bind(handle);
      // Establish the owner at admission and count its first close as well as
      // retries; stream teardown must not supply an implicit extra attempt.
      cleanupState.firstHandle ??= handle;
      if (cleanupState.abortController !== undefined)
        setImmediate(() => {
          cleanupState.abortController?.abort();
          cleanupState.abortController = undefined;
        });
      handle.close = async () => {
        if (handle === cleanupState.firstHandle)
          cleanupState.firstHandleCloseAttempts += 1;
        if (
          cleanupState.failFirstClose &&
          handle === cleanupState.firstHandle
        ) {
          cleanupState.failFirstClose = false;
          throw new Error("injected descriptor close failure");
        }
        return close();
      };
      return handle;
    },
  };
});

import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { GoBinaryProvider } from "../../../src/go/GoBinaryProvider.js";
import { PeResourcesProvider } from "../../../src/native/pe/PeResourcesProvider.js";
import { createGoBinaryFixture } from "../../fixtures/go/image.js";
import { peResourceFixture } from "../../../src/domain/pe/peResources.fixture.js";
import { representativeComponent } from "../../../src/wasm/WasmComponentBinary.fixture.js";
import { WasmComponentProvider } from "../../../src/wasm/WasmComponentProvider.js";

const PROVIDERS = {
  go: {
    file: "program.elf",
    bytes: () => createGoBinaryFixture().bytes,
    create: () => new GoBinaryProvider(),
  },
  pe: {
    file: "program.exe",
    bytes: () => peResourceFixture().bytes,
    create: () => new PeResourcesProvider(),
  },
  "wasm-component": {
    file: "component.wasm",
    bytes: representativeComponent,
    create: () => new WasmComponentProvider(),
  },
} as const;

it.each(["go", "pe", "wasm-component"] as const)(
  "%s provider retains a failed descriptor close and retries that owner before the next read",
  async (kind) => {
    const root = await createTestTempDirectory("rea-read-cleanup-");
    const fixture = PROVIDERS[kind];
    const path = join(root, fixture.file);
    await writeFile(path, fixture.bytes());
    const provider = fixture.create();
    cleanupState.failFirstClose = true;
    const controller = new AbortController();
    cleanupState.abortController = controller;
    cleanupState.firstHandle = undefined;
    cleanupState.firstHandleCloseAttempts = 0;
    try {
      const input = {
        path,
        max_file_bytes: 8 * 1024 * 1024,
        max_entries: 4096,
      };
      const first = await provider.inspect(input, {
        signal: controller.signal,
      });
      if (first.ok) throw new Error("Injected close failure was not returned");
      expect(projectAnalysisError(first.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: { diagnostics: { primary_error: { code: "cancelled" } } },
      });
      expect(first.error.cause).toBeInstanceOf(AggregateError);
      if (!(first.error.cause instanceof AggregateError))
        throw first.error.cause;
      expect(first.error.cause.errors[1]).toMatchObject({
        cleanupResources: [path],
      });
      expect(cleanupState.firstHandleCloseAttempts).toBe(1);
      const retainedHandle = openedFirstHandle();
      expect(retainedHandle.fd).toBeGreaterThanOrEqual(0);

      const retry = await provider.inspect(input);
      expect(retry.ok).toBe(true);
      expect(cleanupState.firstHandleCloseAttempts).toBe(2);
      expect(retainedHandle.fd).toBe(-1);
    } finally {
      await provider.close();
      cleanupState.failFirstClose = false;
      cleanupState.abortController = undefined;
      cleanupState.firstHandle = undefined;
      cleanupState.firstHandleCloseAttempts = 0;
    }
  },
);
