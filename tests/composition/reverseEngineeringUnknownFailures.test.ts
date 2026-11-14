import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ReverseEngineeringService } from "../../src/application/reverse/ReverseEngineeringService.js";
import { analysisErrorProjectionSchema } from "../../src/contracts/errorSchemas.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { OwnedCommandFailure } from "../../src/process/OwnedCommand.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { findsNoExecutable } from "../support/reverseEngineeringService.js";

it.each([false, true])(
  "keeps owned output collection failure primary after late cancellation=%s",
  async (cancel) => {
    const controller = new AbortController();
    const abortReason = { caller: "cancelled after collection failure" };
    const physical = Object.assign(new Error("output pipe read failed"), {
      code: "EIO",
    });
    const owned = new OwnedCommandFailure(
      "process",
      "owned output collection failed",
      {
        stdout: { text: "retained", bytes: 8, observedBytes: 8 },
        stderr: { text: "", bytes: 0, observedBytes: 0 },
        exitCode: 0,
        signal: null,
      },
      null,
      { cause: physical, collectionFailure: true },
    );
    const profile = {
      executable: "unused",
      arguments: [],
      identity: { id: "fixture", name: "fixture", version: null },
    };
    const service = new ReverseEngineeringService({
      commands: { objdump: () => profile, rizin: () => profile },
      processes: {
        lookup: findsNoExecutable,
        runOwned: async () => {
          if (cancel) controller.abort(abortReason);
          throw owned;
        },
      },
    });
    const result = await service.inspectWithObjdump(
      { operation: "architectures" },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected output collection failure");
    expect(result.error._tag).toBe("AnalysisOutputError");
    expect(result.error.cause).toMatchObject({ cause: owned });
    expect(owned.cause).toBe(physical);
    expect(result.error.capturedOutput).toMatchObject({
      stdout: "retained",
      stdout_bytes: 8,
      exit_code: null,
    });
    expect(result.error.secondaryFailures).toHaveLength(cancel ? 1 : 0);
    if (cancel)
      expect(result.error.secondaryFailures[0]?.cause).toBe(abortReason);
    await service.close();
  },
);

it("keeps the owned producer cancellation reason authoritative", async () => {
  const controller = new AbortController();
  const abortReason = { caller: "owned process cancelled" };
  const profile = {
    executable: "unused",
    arguments: [],
    identity: { id: "fixture", name: "fixture", version: null },
  };
  const service = new ReverseEngineeringService({
    commands: { objdump: () => profile, rizin: () => profile },
    processes: {
      lookup: findsNoExecutable,
      runOwned: async () => {
        controller.abort(abortReason);
        throw new OwnedCommandFailure("cancelled", "owned process cancelled");
      },
    },
  });
  const result = await service.inspectWithObjdump(
    { operation: "architectures" },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected producer cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cause).toBe(abortReason);
  expect(result.error.secondaryFailures).toEqual([]);
  await service.close();
});

it.each([
  { stage: "stat", cause: null },
  { stage: "stat", cause: undefined },
  { stage: "command", cause: null },
  { stage: "command", cause: undefined },
] as const)(
  "preserves a $cause rejection from $stage without throwing while classifying it",
  async ({ stage, cause }) => {
    const root = await createTestTempDirectory("rea-reverse-unknown-failure-");
    const path = join(root, "input.bin");
    await writeFile(path, new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
    const run = vi.fn(async () => {
      throw cause;
    });
    const service = new ReverseEngineeringService({
      stat:
        stage === "stat"
          ? async () => {
              throw cause;
            }
          : stat,
      processes: { lookup: findsNoExecutable, run },
      commands: {
        objdump: () => ({
          executable: "unused-objdump",
          arguments: [path],
          identity: { id: "test.objdump", name: "Test objdump", version: null },
        }),
        rizin: () => ({
          executable: "unused-rizin",
          arguments: [path],
          identity: { id: "test.rizin", name: "Test Rizin", version: null },
        }),
      },
    });

    const result = await service.inspectWithObjdump({
      path,
      operation: "symbols",
    });
    if (result.ok) throw new Error("Expected injected boundary rejection");
    expect(result.error.cause).toBe(cause);
    const projected = projectAnalysisError(result.error);
    expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(
      true,
    );
    expect(projected.code).toBe(
      stage === "stat" ? "execution_failure" : "capability_unavailable",
    );
    if (stage === "stat") expect(run).not.toHaveBeenCalled();
    else expect(run).toHaveBeenCalledOnce();
    await service.close();
  },
);
