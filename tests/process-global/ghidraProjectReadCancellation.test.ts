import { mkdir, realpath, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../src/resources/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../../src/domain/analysisErrorCore.js";
import { resolveGhidraProject } from "../../src/ghidra/GhidraProjectSnapshot.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { phaseGate } from "../support/lifecycleHarness.js";

const projectFileClose = vi.hoisted(() => ({
  path: "",
  hold: undefined as ((handle: FileHandle) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const hold =
        args[0] === projectFileClose.path ? projectFileClose.hold : undefined;
      if (hold === undefined) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await hold(handle);
        await close();
      };
      return handle;
    },
  };
});

it.each([null, { source: "caller" }])(
  "preserves cancellation reason %j while closing the final project file",
  async (reason) => {
    const root = await realpath(
      await createTestTempDirectory("rea-ghidra-read-cancel-"),
    );
    const marker = join(root, "selected.gpr");
    const data = join(root, "selected.rep");
    const lastFile = join(data, "last");
    await mkdir(data);
    await writeFile(marker, "marker");
    await writeFile(lastFile, "project data");
    const resources = new ArtifactResourceScope();
    const gate = phaseGate<FileHandle>();
    const controller = new AbortController();
    projectFileClose.path = lastFile;
    projectFileClose.hold = gate.hold;
    const pending = resolveGhidraProject(
      { path: marker },
      { path: join(root, "target") },
      resources,
      controller.signal,
    );
    try {
      const handle = await gate.reached(pending, "final project file close");
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      controller.abort(reason);
      expect(
        await Promise.race([
          pending.then(
            () => "settled",
            () => "settled",
          ),
          setImmediate("held"),
        ]),
      ).toBe("held");

      gate.release();
      await expect(pending).rejects.toBeInstanceOf(AnalysisCancelledError);
      await expect(pending).rejects.toMatchObject({
        operation: "resolve_analysis_profile",
        cause: reason,
      });
      expect(handle.fd).toBe(-1);
    } finally {
      gate.release();
      await pending.catch(() => undefined);
      projectFileClose.hold = undefined;
      await resources.close();
    }
  },
);
