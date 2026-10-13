import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

const injected = vi.hoisted(() => ({
  sourcePath: undefined as string | undefined,
  abortController: undefined as AbortController | undefined,
  failClose: false,
  closeAttempts: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] !== injected.sourcePath) return handle;
      const createReadStream = handle.createReadStream.bind(handle);
      handle.createReadStream = (options) => {
        injected.abortController?.abort();
        return createReadStream(options);
      };
      const close = handle.close.bind(handle);
      handle.close = async () => {
        injected.closeAttempts += 1;
        if (injected.failClose) throw new Error("fixture close refusal");
        await close();
      };
      return handle;
    },
  };
});

import { WebModuleTraceService } from "../../../src/application/WebModuleTraceService.js";
import { LocalWebModuleArtifacts } from "../../../src/browser/modules/WebModuleArtifacts.js";
import { webModuleArtifactsFixture } from "../../fixtures/webModuleTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains cancelled source read ownership until service close retries it", async () => {
  const root = await createTestTempDirectory("rea-web-artifact-read-owner-");
  onTestFinished(async () => {
    injected.sourcePath = undefined;
    injected.abortController = undefined;
    injected.failClose = false;
    injected.closeAttempts = 0;
    await rm(root, { recursive: true, force: true });
  });
  const source = 'import "./dep.js";';
  const fixture = webModuleArtifactsFixture(source);
  const manifestPath = join(root, "manifest.json");
  const sourcePath = join(root, "files", "modules", "main.js");
  await mkdir(join(root, "files", "modules"), { recursive: true });
  await writeFile(sourcePath, source);
  await writeFile(manifestPath, JSON.stringify(fixture.manifest));

  injected.sourcePath = sourcePath;
  injected.failClose = true;
  const controller = new AbortController();
  injected.abortController = controller;
  const resolver = {
    resolve: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const service = new WebModuleTraceService(
    new LocalWebModuleArtifacts(),
    resolver,
  );
  const input = { manifest_path: manifestPath, script_index: 0 };

  const cancelled = await service.trace(input, { signal: controller.signal });
  expect(cancelled.ok).toBe(false);
  if (cancelled.ok) throw new Error("Expected cancelled source read");
  expect(cancelled.error.cleanupIncomplete).toBe(true);
  expect(cancelled.error.cleanupResources).toContain(sourcePath);
  expect(resolver.resolve).not.toHaveBeenCalled();

  injected.abortController = undefined;
  const blocked = await service.trace(input);
  expect(blocked.ok).toBe(false);
  if (blocked.ok) throw new Error("Expected retained cleanup to block load");
  expect(blocked.error.cleanupIncomplete).toBe(true);
  expect(injected.closeAttempts).toBe(2);

  await expect(service.close()).rejects.toThrow(
    "Web module trace cleanup failed",
  );
  expect(resolver.close).toHaveBeenCalledTimes(1);
  expect(injected.closeAttempts).toBe(3);

  injected.failClose = false;
  const attemptsBeforeRetry = injected.closeAttempts;
  await service.close();
  expect(injected.closeAttempts).toBeGreaterThan(attemptsBeforeRetry);
  expect(resolver.close).toHaveBeenCalledTimes(2);
});
