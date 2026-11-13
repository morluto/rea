import { fstatSync, statSync, existsSync } from "node:fs";
import { OwnedFileHandle } from "../../../../src/filesystem/OwnedFileHandle.js";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { failedInspectionDescriptor } from "../../../fixtures/processInspectionCleanup.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../../../../src/process/ProcessInspectionCancellation.js";
import { unlink, writeFile } from "node:fs/promises";
import { expect, it as test, vi } from "vitest";
import { withVerifierCleanup } from "../../../../scripts/lib/verifier-cleanup.mjs";
import { KunaTargetCommands } from "../../../../src/kuna/KunaTargetCommands.js";
import { systemProcessOwnershipHost } from "../../../../src/process/ProcessOwnershipObservation.js";
import { ExecFileOutputCancelledError } from "../../../../src/process/ExecFileOutput.js";
import { PrivateRuntimeRoot } from "../../../../src/process/PrivateRuntimeRoot.js";
import { ProviderCleanupError } from "../../../../src/domain/providerCleanupError.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { awaitAcknowledgement } from "../../../fixtures/lifecycleAcknowledgement.js";
import { session } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

it.each(["changed", "missing"] as const)(
  "retains a %s target's failed workspace rollback and blocks replacement until retry",
  async (mode) => {
    const fixture = await session("rea-kuna-workspace-rollback-");
    if (mode === "changed")
      await writeFile(fixture.target.path, "changed bytes");
    else await unlink(fixture.target.path);
    const lifetime = new AbortController();
    const commands = new KunaTargetCommands(fixture.target, {
      signal: lifetime.signal,
    });
    const create = PrivateRuntimeRoot.create;
    let allocations = 0;
    let owned: PrivateRuntimeRoot | undefined;
    const closeSpies: ReturnType<typeof vi.spyOn>[] = [];
    const roots = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async (options) => {
        const root = await create(options);
        owned = root;
        allocations += 1;
        closeSpies.push(
          vi
            .spyOn(root, "close")
            .mockRejectedValue(new Error("controlled rollback refusal")),
        );
        return root;
      });
    try {
      const result = await commands.prepare();
      if (result.ok) throw new Error("Expected workspace failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toEqual([owned?.path]);
      expect(result.error.cleanupPrimary?._tag).toBe(
        mode === "changed"
          ? "AnalysisArtifactChangedError"
          : "ProviderAdapterError",
      );
      const again = await commands.prepare();
      if (again.ok) throw new Error("Expected retained rollback failure");
      expect(again.error).toBe(result.error);
      expect(allocations).toBe(1);
      const failedClose = await commands.close();
      if (failedClose.ok) throw new Error("Expected cleanup refusal");
      expect(result.error.cleanupIncomplete).toBe(true);
      for (const spy of closeSpies) spy.mockRestore();
      expect((await commands.close()).ok).toBe(true);
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(failedClose.error.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(result.error).code).toBe(
        mode === "changed" ? "artifact_changed" : "execution_failure",
      );
    } finally {
      roots.mockRestore();
      for (const spy of closeSpies) spy.mockRestore();
      expect((await commands.close()).ok).toBe(true);
    }
  },
);

it.each(["clean", "refuse"] as const)(
  "joins rollback finalization without replacing the primary failure when close cancels: %s",
  async (mode) => {
    const fixture = await session("rea-kuna-workspace-finalization-");
    await writeFile(fixture.target.path, "changed bytes");
    const lifetime = new AbortController();
    const commands = new KunaTargetCommands(fixture.target, {
      signal: lifetime.signal,
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = PrivateRuntimeRoot.create;
    let holdFailures = mode === "refuse";
    let rootClose: ReturnType<typeof vi.spyOn> | undefined;
    const roots = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async (options) => {
        const root = await create(options);
        const close = root.close.bind(root);
        rootClose = vi.spyOn(root, "close").mockImplementation(async () => {
          entered();
          await gate;
          if (holdFailures) throw new Error("controlled finalization refusal");
          await close();
        });
        return root;
      });
    const pending = commands.prepare();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let closing: ReturnType<typeof commands.close> | undefined;
    await withVerifierCleanup(async () => {
      await awaitAcknowledgement(started, pending, "workspace rollback");
      lifetime.abort({ caller: "shutdown during rollback" });
      closing = commands.close();
      let closed = false;
      void closing.then(
        () => {
          closed = true;
        },
        () => {
          closed = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(closed).toBe(false);
      release();
      const result = await pending;
      if (result.ok) throw new Error("Expected changed-target failure");
      expect(result.error.cleanupIncomplete).toBe(mode === "refuse");
      const outcome = await closing;
      expect(outcome.ok).toBe(mode === "clean");
      if (!outcome.ok) {
        holdFailures = false;
        expect((await commands.close()).ok).toBe(true);
        expect(outcome.error.cleanupIncomplete).toBe(false);
      }
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(result.error).code).toBe("artifact_changed");
    }, [
      () => {
        holdFailures = false;
        release();
      },
      async () => {
        await pending;
      },
      async () => {
        await closing;
      },
      () => rootClose?.mockRestore(),
      () => roots.mockRestore(),
      async () => {
        expect((await commands.close()).ok).toBe(true);
      },
    ]);
  },
);

it.each(["changed", "missing"] as const)(
  "permits a fresh workspace after a %s target rolls back cleanly",
  async (mode) => {
    const fixture = await session("rea-kuna-workspace-clean-retry-");
    if (mode === "changed")
      await writeFile(fixture.target.path, "changed bytes");
    else await unlink(fixture.target.path);
    const commands = new KunaTargetCommands(fixture.target, {
      signal: new AbortController().signal,
    });
    try {
      const failed = await commands.prepare();
      if (failed.ok) throw new Error("Expected target failure");
      expect(failed.error.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(failed.error).code).toBe(
        mode === "changed" ? "artifact_changed" : "execution_failure",
      );
      await writeFile(fixture.target.path, "program bytes");
      expect((await commands.prepare()).ok).toBe(true);
    } finally {
      expect((await commands.close()).ok).toBe(true);
    }
  },
);

it.each([
  new Error("controlled allocation failure"),
  null,
  new ProviderCleanupError("foreign", ["foreign-owner"], {}),
])(
  "returns an allocation failure without inventing an owner and permits retry: %j",
  async (reason) => {
    const fixture = await session("rea-kuna-workspace-allocation-");
    const commands = new KunaTargetCommands(fixture.target, {
      signal: new AbortController().signal,
    });
    const roots = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockRejectedValue(reason);
    try {
      const failed = await commands.prepare();
      if (failed.ok) throw new Error("Expected allocation failure");
      if (reason instanceof ProviderCleanupError) {
        expect(failed.error).toBe(reason);
        expect(reason.cleanupIncomplete).toBe(true);
        expect(reason.cleanupResources).toEqual(["foreign-owner"]);
      } else {
        expect(failed.error.cause).toBe(reason);
        expect(failed.error.cleanupIncomplete).toBe(false);
        expect(failed.error.cleanupResources).toEqual([]);
      }
      roots.mockRestore();
      if (reason instanceof ProviderCleanupError) {
        expect((await commands.prepare()).ok).toBe(false);
        reason.resolveCleanup();
        // Observe the settled cached failure before admitting a fresh allocation.
        const settled = await commands.prepare();
        expect(settled).toEqual({ ok: false, error: reason });
        expect(reason.cleanupIncomplete).toBe(false);
      }
      expect((await commands.prepare()).ok).toBe(true);
    } finally {
      roots.mockRestore();
      expect((await commands.close()).ok).toBe(true);
    }
  },
);

it("keeps caller attribution and the selected path through workspace rollback retry", async () => {
  const fixture = await session("rea-kuna-workspace-caller-");
  await writeFile(fixture.target.path, "changed bytes");
  const client = fixture.open();
  const create = PrivateRuntimeRoot.create;
  let refuseClose: ReturnType<typeof vi.spyOn> | undefined;
  const roots = vi
    .spyOn(PrivateRuntimeRoot, "create")
    .mockImplementation(async (options) => {
      const root = await create(options);
      refuseClose = vi
        .spyOn(root, "close")
        .mockRejectedValue(new Error("controlled rollback refusal"));
      return root;
    });
  try {
    const failed = await client.execute("search_procedures", {
      pattern: "main",
      mode: "literal",
    });
    if (failed.ok)
      throw new Error("Expected changed target with retained rollback");
    expect(failed.error.cleanupIncomplete).toBe(true);
    expect(failed.error.cleanupPrimary).toMatchObject({
      _tag: "AnalysisArtifactChangedError",
      operation: "search_procedures",
      path: fixture.target.path,
    });
    expect(projectAnalysisError(failed.error).details).toMatchObject({
      operation: "search_procedures",
    });
    expect((await client.close()).ok).toBe(false);
    refuseClose?.mockRestore();
    expect((await client.close()).ok).toBe(true);
    expect(failed.error.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(failed.error)).toMatchObject({
      code: "artifact_changed",
      details: { operation: "search_procedures", path: fixture.target.path },
    });
  } finally {
    refuseClose?.mockRestore();
    roots.mockRestore();
    expect((await client.close()).ok).toBe(true);
  }
});

it.each([
  { stage: "copy", mode: "clean" },
  { stage: "copy", mode: "refuse" },
  { stage: "inspection", mode: "clean" },
  { stage: "inspection", mode: "refuse" },
] as const)(
  "preserves workspace $stage cancellation and retries its $mode rollback",
  async ({ stage, mode }) => {
    const fixture = await session("rea-kuna-workspace-cancel-");
    const lifetime = new AbortController();
    const reason = { caller: "cancel target copy" };
    const commands = new KunaTargetCommands(fixture.target, {
      signal: lifetime.signal,
    });
    const create = PrivateRuntimeRoot.create;
    let rootClose: ReturnType<typeof vi.spyOn> | undefined;
    const roots = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async (options) => {
        const root = await create(options);
        if (mode === "refuse")
          rootClose = vi
            .spyOn(root, "close")
            .mockRejectedValue(new Error("controlled rollback refusal"));
        if (stage === "copy") lifetime.abort(reason);
        return root;
      });
    let inspectionCalls = 0;
    const prepare = systemProcessOwnershipHost.prepare;
    const inspection = vi
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockImplementation(async (signal) => {
        if (stage === "inspection" && signal === lifetime.signal) {
          inspectionCalls += 1;
          lifetime.abort(reason);
          throw ProcessOwnershipInspectionCancelled.from(
            new ExecFileOutputCancelledError(reason),
          );
        }
        await prepare?.(signal);
      });
    try {
      const result = await commands.prepare();
      if (result.ok) throw new Error("Expected cancelled workspace admission");
      expect(inspectionCalls).toBe(stage === "inspection" ? 1 : 0);
      const primary = result.error.cleanupPrimary ?? result.error;
      expect(primary).toMatchObject({
        _tag: "AnalysisCancelledError",
        cause: reason,
      });
      expect(result.error.cleanupIncomplete).toBe(mode === "refuse");
      if (mode === "refuse") {
        expect((await commands.close()).ok).toBe(false);
        rootClose?.mockRestore();
        expect((await commands.close()).ok).toBe(true);
        expect(result.error.cleanupIncomplete).toBe(false);
        expect(result.error.cleanupPrimary).toBe(primary);
      }
    } finally {
      inspection.mockRestore();
      roots.mockRestore();
      rootClose?.mockRestore();
      expect((await commands.close()).ok).toBe(true);
    }
  },
);

it.each([false, true])(
  "does not relabel a physical workspace failure when cancellation also arrives (same reason: %s)",
  async (sameReason) => {
    const fixture = await session("rea-kuna-workspace-physical-");
    const lifetime = new AbortController();
    const physical = new Error("controlled workspace creation failure");
    const reason = sameReason ? physical : { caller: "concurrent shutdown" };
    const commands = new KunaTargetCommands(fixture.target, {
      signal: lifetime.signal,
    });
    const roots = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async () => {
        lifetime.abort(reason);
        throw physical;
      });
    try {
      const result = await commands.prepare();
      if (result.ok) throw new Error("Expected physical workspace failure");
      expect(result.error).toMatchObject({
        _tag: "ProviderAdapterError",
        cause: physical,
      });
      expect(
        result.error.secondaryFailures.some(
          (failure) => failure.cause === reason,
        ),
      ).toBe(true);
    } finally {
      roots.mockRestore();
      expect((await commands.close()).ok).toBe(true);
    }
  },
);

it("preserves the exact input-head admission cancellation reason", async () => {
  const target = await inertTarget("rea-kuna-input-head-cancel-");
  const lifetime = new AbortController();
  const reason = { caller: "cancel input head" };
  const commands = new KunaTargetCommands(target, {
    signal: lifetime.signal,
  });
  lifetime.abort(reason);
  try {
    const result = await commands.inputHead("inspect_input");
    if (result.ok) throw new Error("Expected cancelled input-head admission");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      operation: "inspect_input",
    });
    expect(result.error.cause).toBe(reason);
  } finally {
    expect((await commands.close()).ok).toBe(true);
  }
});

it.each([false, true])(
  "preserves explicit batch cancellation and observations during workspace preparation (mixed: %s)",
  async (mixed) => {
    const target = await inertTarget("rea-kuna-workspace-batch-");
    const lifetime = new AbortController();
    const commands = new KunaTargetCommands(target, {
      signal: lifetime.signal,
    });
    const reason = { caller: "cancel identity request" };
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
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockRejectedValue(batch);
    try {
      const result = await commands.prepare();
      if (result.ok) throw new Error("Expected identity batch failure");
      expect(lifetime.signal.aborted).toBe(false);
      if (mixed) {
        expect(result.error._tag).toBe("ProviderAdapterError");
        expect(result.error.cause).toBe(batch);
        expect(
          result.error.secondaryFailures.some(
            (failure) => failure.cause === reason,
          ),
        ).toBe(true);
      } else {
        expect(result.error._tag).toBe("AnalysisCancelledError");
        expect(result.error.cause).toBe(reason);
        expect(result.error).toHaveProperty("inspectionFailure", batch);
      }
      expect(batch.observations).toBe(observations);
    } finally {
      prepare.mockRestore();
      expect((await commands.close()).ok).toBe(true);
    }
  },
);

it("keeps inspection descriptor cleanup errors live through the exact workspace-owner retry", async () => {
  const target = await inertTarget("rea-kuna-inspection-fd-");
  const descriptor = await failedInspectionDescriptor();
  const reason = { caller: "cancel sibling inspection" };
  const batch = new ProcessOwnershipIdentityBatchFailure(
    [
      {
        pid: 402,
        requestIndex: 0,
        cause: new ProcessOwnershipInspectionCancelled(reason),
      },
      { pid: 403, requestIndex: 1, cause: descriptor.failure },
    ],
    new Map(),
  );
  const prepare = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(batch);
  const commands = new KunaTargetCommands(target, {
    signal: new AbortController().signal,
  });
  try {
    const result = await commands.prepare();
    if (result.ok) throw new Error("Expected retained inspection descriptor");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toContain(descriptor.path);
    const refused = await commands.close();
    if (refused.ok) throw new Error("Expected exact descriptor retry refusal");
    expect(refused.error.cleanupIncomplete).toBe(true);
    expect((await descriptor.handle.stat()).isFile()).toBe(true);
    descriptor.allow();
    expect((await commands.close()).ok).toBe(true);
    await expect(descriptor.handle.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(refused.error.cleanupIncomplete).toBe(false);
  } finally {
    descriptor.allow();
    prepare.mockRestore();
    expect((await commands.close()).ok).toBe(true);
  }
});

const inertTarget = async (prefix: string): Promise<BinaryTarget> => {
  const root = await createTestTempDirectory(prefix);
  const path = join(root, "program");
  const bytes = "inert workspace copy input";
  await writeFile(path, bytes);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "executable",
    format: "elf",
    architecture: "x86_64",
    availableArchitectures: ["x86_64"],
  };
};

it.each(["source", "destination", "both"] as const)(
  "retries the exact copy %s descriptors before removing the workspace root",
  async (side) => {
    const target = await inertTarget("rea-kuna-copy-close-");
    const commands = new KunaTargetCommands(target, {
      signal: new AbortController().signal,
    });
    const create = PrivateRuntimeRoot.create;
    let root: PrivateRuntimeRoot | undefined;
    let rootClose: ReturnType<typeof vi.spyOn> | undefined;
    let allow = false;
    const retained = new Set<OwnedFileHandle>();
    const sourceIdentity = statSync(target.path);
    const roots = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async (options) => {
        root = await create(options);
        rootClose = vi.spyOn(root, "close");
        return root;
      });
    const originalClose = OwnedFileHandle.prototype.close;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        const observed =
          this.handle.fd < 0 ? undefined : fstatSync(this.handle.fd);
        const input =
          root === undefined
            ? undefined
            : join(root.path, basename(target.path));
        const destination =
          input !== undefined && existsSync(input)
            ? statSync(input)
            : undefined;
        const isSource =
          observed?.dev === sourceIdentity.dev &&
          observed?.ino === sourceIdentity.ino;
        const isDestination =
          destination !== undefined &&
          observed?.dev === destination.dev &&
          observed?.ino === destination.ino;
        if (
          (side !== "destination" && isSource) ||
          (side !== "source" && isDestination)
        ) {
          retained.add(this);
          if (!allow)
            throw new Error("controlled copy descriptor close refusal");
        }
        await originalClose.call(this);
      });
    try {
      const result = await commands.prepare();
      if (result.ok) throw new Error("Expected workspace copy close failure");
      expect(retained.size).toBe(side === "both" ? 2 : 1);
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(rootClose).not.toHaveBeenCalled();
      if (root === undefined)
        throw new Error("Expected retained workspace root");
      expect(existsSync(root.path)).toBe(true);
      for (const owner of retained)
        expect(fstatSync(owner.handle.fd).isFile()).toBe(true);
      const refused = await commands.close();
      if (refused.ok)
        throw new Error("Expected exact copy descriptor retry refusal");
      expect(rootClose).not.toHaveBeenCalled();
      expect(result.error.cleanupIncomplete).toBe(true);
      allow = true;
      expect((await commands.close()).ok).toBe(true);
      for (const owner of retained)
        expect(() => fstatSync(owner.handle.fd)).toThrow();
      expect(rootClose).toHaveBeenCalledOnce();
      expect(existsSync(root.path)).toBe(false);
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(refused.error.cleanupIncomplete).toBe(false);
    } finally {
      allow = true;
      for (const owner of retained) await originalClose.call(owner);
      close.mockRestore();
      roots.mockRestore();
      expect((await commands.close()).ok).toBe(true);
    }
  },
);
