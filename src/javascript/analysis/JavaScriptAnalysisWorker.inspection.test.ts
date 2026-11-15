import { failedInspectionDescriptor } from "../../../tests/fixtures/processInspectionCleanup.js";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { JavaScriptAnalysisWorker } from "./JavaScriptAnalysisWorker.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { primaryAnalysisError } from "../../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { DarwinProcessOwnershipInspectionError } from "../../process/DarwinProcessRunTokenReader.js";
import { ExecFileOutputCancelledError } from "../../process/ExecFileOutput.js";
import {
  ProcessOwnershipInspectionCancelled,
  ProcessOwnershipIdentityBatchFailure,
} from "../../process/ProcessInspectionCancellation.js";
import * as ownership from "../../process/ProcessOwnershipObservation.js";

const text = "export const observed = 1;";
const file: JavaScriptArtifactFile = {
  path: "app.mjs",
  sha256: createHash("sha256").update(text).digest("hex"),
  container_sha256: "1".repeat(64),
  bytes: Buffer.byteLength(text),
  inventory_artifact_id: "fixture-source",
  kind: "javascript",
  unpacked: false,
  text: { included: true, value: text },
};

it.each(["prepare", "launch"] as const)(
  "uses owned cancellation facts at %s while preserving physical rejection",
  async (stage) => {
    for (const kind of [
      "typed",
      "normalized-exec",
      "physical",
      "same-reason",
      "abort-shaped",
    ] as const) {
      const controller = new AbortController();
      const physical =
        kind === "abort-shaped"
          ? new DOMException("unrelated rejected I/O", "AbortError")
          : new Error("inspection failed physically");
      const reason = kind === "same-reason" ? physical : { caller: kind };
      const fail = async () => {
        controller.abort(reason);
        if (kind === "typed")
          throw new ProcessOwnershipInspectionCancelled(reason);
        if (kind === "normalized-exec")
          throw ProcessOwnershipInspectionCancelled.from(
            new ExecFileOutputCancelledError(reason),
          );
        throw physical;
      };
      const prepare = vi
        .spyOn(ownership, "prepareProcessOwnershipInspection")
        .mockImplementation(stage === "prepare" ? fail : async () => {});
      const launcher = vi.fn(fail);
      const worker = new JavaScriptAnalysisWorker(
        { heapMb: 128, timeoutMs: 5_000 },
        launcher,
      );
      try {
        const result = await worker.analyze(
          file,
          { nodes: 100, unknowns: 100 },
          controller.signal,
        );
        if (result.ok) throw new Error("Expected admission failure");
        const primary = primaryAnalysisError(result.error.error);
        if (kind === "typed" || kind === "normalized-exec") {
          expect(primary).toBeInstanceOf(AnalysisCancelledError);
          expect(primary.cause).toBe(reason);
        } else {
          expect(primary.userCategory).not.toBe("cancelled");
          expect(primary.cause).toBe(physical);
          expect(
            primary.secondaryFailures.some((failure) =>
              Object.is(failure.cause, reason),
            ),
          ).toBe(true);
        }
        expect(launcher).toHaveBeenCalledTimes(stage === "launch" ? 1 : 0);
      } finally {
        prepare.mockRestore();
        await worker.close();
      }
    }
  },
);

it("retries the exact failed inspection owner before releasing its error", async () => {
  const reason = { caller: "cancel helper preparation" };
  const cleanup = new ProviderCleanupError(
    "process-ownership",
    ["retained-inspector"],
    {},
    { operation: "prepare_owned_process" },
  );
  let denied = true;
  const owner = {
    close: vi.fn(async () => {
      if (denied) throw cleanup;
      cleanup.resolveCleanup();
    }),
  };
  const prepare = vi
    .spyOn(ownership, "prepareProcessOwnershipInspection")
    .mockRejectedValue(
      new DarwinProcessOwnershipInspectionError("helper cleanup failed", {
        cancellation: { reason },
        cleanupFailure: cleanup,
        cleanupOwner: owner,
      }),
    );
  const launcher = vi.fn(async () => {
    throw new Error("must not launch");
  });
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 5_000 },
    launcher,
  );
  try {
    const result = await worker.analyze(file, { nodes: 100, unknowns: 100 });
    if (result.ok) throw new Error("Expected inspection cleanup failure");
    expect(result.error.error.cleanupIncomplete).toBe(true);
    expect(result.error.error.cleanupResources).toContain("retained-inspector");
    expect(primaryAnalysisError(result.error.error).cause).toBe(reason);
    await expect(worker.close()).rejects.toBeDefined();
    expect(result.error.error.cleanupIncomplete).toBe(true);
    expect(launcher).not.toHaveBeenCalled();
    denied = false;
    await worker.close();
    expect(result.error.error.cleanupIncomplete).toBe(false);
    expect(primaryAnalysisError(result.error.error).cause).toBe(reason);
  } finally {
    denied = false;
    prepare.mockRestore();
    await worker.close();
  }
});

it.each([false, true])(
  "preserves batch observations and explicit cancellation (mixed: %s)",
  async (mixed) => {
    const reason = { caller: "cancel one inspection request" };
    const observations = new Map([
      [401, { state: "readable", identity: "recorded-native-start" } as const],
    ]);
    const batch = new ProcessOwnershipIdentityBatchFailure(
      [
        {
          pid: 402,
          requestIndex: 1,
          cause: new ProcessOwnershipInspectionCancelled(reason),
        },
        ...(mixed
          ? [
              {
                pid: 403,
                requestIndex: 2,
                cause: new Error("physical native read failure"),
              },
            ]
          : []),
      ],
      observations,
    );
    const prepare = vi
      .spyOn(ownership, "prepareProcessOwnershipInspection")
      .mockRejectedValue(batch);
    const launcher = vi.fn(async () => {
      throw new Error("must not launch");
    });
    const worker = new JavaScriptAnalysisWorker(
      { heapMb: 128, timeoutMs: 5_000 },
      launcher,
    );
    try {
      const result = await worker.analyze(file, { nodes: 100, unknowns: 100 });
      if (result.ok) throw new Error("Expected batch failure");
      const error = primaryAnalysisError(result.error.error);
      if (mixed) {
        expect(error.userCategory).not.toBe("cancelled");
        expect(error.cause).toBe(batch);
        expect(
          error.secondaryFailures.some((failure) => failure.cause === reason),
        ).toBe(true);
      } else {
        expect(error).toBeInstanceOf(AnalysisCancelledError);
        expect(error.cause).toBe(reason);
        expect(error).toHaveProperty("inspectionFailure", batch);
      }
      expect(batch.observations).toBe(observations);
      expect(batch.observations.get(401)).toEqual({
        state: "readable",
        identity: "recorded-native-start",
      });
      expect(launcher).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      await worker.close();
    }
  },
);

it.each(["cancelled", "physical"] as const)(
  "preserves the owned startup deadline and %s origin",
  async (origin) => {
    const prepare = vi
      .spyOn(ownership, "prepareProcessOwnershipInspection")
      .mockResolvedValue();
    const physical = new Error("physical launch failure after deadline");
    const launcher = vi.fn(
      async (
        options: Parameters<
          typeof import("../../process/ProviderProcess.js").spawnOwnedProviderProcess
        >[0],
      ) => {
        const signal = options.signal;
        if (signal === undefined)
          throw new Error("Expected owned startup deadline signal");
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        if (origin === "cancelled")
          throw new ProcessOwnershipInspectionCancelled(signal.reason);
        throw physical;
      },
    );
    const worker = new JavaScriptAnalysisWorker(
      { heapMb: 128, timeoutMs: 20 },
      launcher,
    );
    try {
      const result = await worker.analyze(file, { nodes: 100, unknowns: 100 });
      if (result.ok) throw new Error("Expected startup failure");
      const error = primaryAnalysisError(result.error.error);
      if (origin === "cancelled")
        expect(error._tag).toBe("AnalysisTimeoutError");
      else {
        expect(error.userCategory).not.toBe("cancelled");
        expect(error.cause).toBe(physical);
        expect(
          error.secondaryFailures.some(
            (failure) => failure._tag === "AnalysisTimeoutError",
          ),
        ).toBe(true);
      }
      expect(launcher).toHaveBeenCalledOnce();
    } finally {
      prepare.mockRestore();
      await worker.close();
    }
  },
);

it("joins a late inspection cleanup handoff before worker close completes", async () => {
  const reason = { caller: "cancel delayed preparation" };
  const cleanup = new ProviderCleanupError(
    "process-ownership",
    ["late-inspector"],
    {},
    { operation: "prepare_owned_process" },
  );
  let acknowledgePreparation!: () => void;
  const preparing = new Promise<void>((resolve) => {
    acknowledgePreparation = resolve;
  });
  let rejectPreparation!: (cause: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectPreparation = reject;
  });
  let acknowledgeRetry!: () => void;
  const retrying = new Promise<void>((resolve) => {
    acknowledgeRetry = resolve;
  });
  let releaseCleanup!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const owner = {
    close: vi.fn(async () => {
      acknowledgeRetry();
      await release;
      cleanup.resolveCleanup();
    }),
  };
  const prepare = vi
    .spyOn(ownership, "prepareProcessOwnershipInspection")
    .mockImplementation(async () => {
      acknowledgePreparation();
      return failure;
    });
  const launcher = vi.fn(async () => {
    throw new Error("must not launch");
  });
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 5_000 },
    launcher,
  );
  let closing: Promise<void> | undefined;
  try {
    const analyzing = worker.analyze(file, { nodes: 100, unknowns: 100 });
    await preparing;
    let closed = false;
    closing = worker.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    rejectPreparation(
      new DarwinProcessOwnershipInspectionError("late helper cleanup failed", {
        cancellation: { reason },
        cleanupFailure: cleanup,
        cleanupOwner: owner,
      }),
    );
    await retrying;
    const result = await analyzing;
    if (result.ok) throw new Error("Expected delayed inspection failure");
    expect(result.error.error.cleanupIncomplete).toBe(true);
    expect(result.error.error.cleanupResources).toContain("late-inspector");
    expect(primaryAnalysisError(result.error.error).cause).toBe(reason);
    expect(closed).toBe(false);
    releaseCleanup();
    await closing;
    expect(owner.close).toHaveBeenCalledOnce();
    expect(result.error.error.cleanupIncomplete).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
  } finally {
    rejectPreparation(new Error("finish retained preparation"));
    releaseCleanup();
    prepare.mockRestore();
    await closing;
    await worker.close();
  }
});

it("retains a mixed identity batch's actual descriptor until the same owner retries", async () => {
  const descriptor = await failedInspectionDescriptor();
  const reason = { caller: "cancel sibling native read" };
  const observations = new Map([
    [401, { state: "readable", identity: "recorded-native-start" } as const],
  ]);
  const batch = new ProcessOwnershipIdentityBatchFailure(
    [
      {
        pid: 402,
        requestIndex: 1,
        cause: new ProcessOwnershipInspectionCancelled(reason),
      },
      { pid: 403, requestIndex: 2, cause: descriptor.failure },
    ],
    observations,
  );
  const prepare = vi
    .spyOn(ownership, "prepareProcessOwnershipInspection")
    .mockRejectedValue(batch);
  const launcher = vi.fn(async () => {
    throw new Error("must not launch");
  });
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 5_000 },
    launcher,
  );
  try {
    const result = await worker.analyze(file, { nodes: 100, unknowns: 100 });
    if (result.ok)
      throw new Error("Expected inspection descriptor cleanup failure");
    const error = result.error.error;
    expect(error.cleanupIncomplete).toBe(true);
    expect(error.cleanupResources).toContain(descriptor.path);
    const primary = primaryAnalysisError(error);
    expect(primary.cause).toBe(batch);
    expect(batch.observations).toBe(observations);
    expect(
      primary.secondaryFailures.some((failure) => failure.cause === reason),
    ).toBe(true);
    expect((await descriptor.handle.stat()).isFile()).toBe(true);
    await expect(worker.close()).rejects.toBeDefined();
    expect(error.cleanupIncomplete).toBe(true);
    descriptor.allow();
    await worker.close();
    await expect(descriptor.handle.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
    expect(error.cleanupIncomplete).toBe(false);
    expect(primary.cause).toBe(batch);
    expect(launcher).not.toHaveBeenCalled();
  } finally {
    descriptor.allow();
    prepare.mockRestore();
    await worker.close();
  }
});
