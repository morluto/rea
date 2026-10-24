import { open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({
  path: "",
  failClose: false,
  failCloseRemaining: 0,
  readFailure: undefined as Error | undefined,
  onClose: undefined as (() => void) | undefined,
  afterClose: undefined as (() => void) | undefined,
  closeAttempts: 0,
  abortAtClose: 1,
  handles: [] as Awaited<ReturnType<typeof open>>[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (resolve(String(args[0])) !== injected.path) return handle;
      injected.handles.push(handle);
      if (injected.readFailure !== undefined)
        vi.spyOn(handle, "read").mockRejectedValue(injected.readFailure);
      const nativeClose = handle.close.bind(handle);
      handle.close = async () => {
        injected.closeAttempts += 1;
        if (injected.closeAttempts === injected.abortAtClose)
          injected.onClose?.();
        if (injected.failClose || injected.failCloseRemaining > 0) {
          if (!injected.failClose) injected.failCloseRemaining -= 1;
          throw Object.assign(new Error("controlled final close failure"), {
            code: "EIO",
          });
        }
        await nativeClose();
        // Run in the next check phase, after the confirmed close settles.
        const after = injected.afterClose;
        if (after !== undefined) setImmediate(after);
      };
      return handle;
    },
  };
});

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../fixtures/binarySession.js";
import { readAnalysisSnapshot } from "../../src/application/binary/AnalysisSnapshotFiles.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../../src/domain/analysisErrorCore.js";
import { RegularFileRetainedCleanupFailure } from "../../src/application/RegularFileRead.js";
import { RegularFileCleanupFailure } from "../../src/filesystem/OwnedRegularFile.js";
import { OwnedFileHandle } from "../../src/filesystem/OwnedFileHandle.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../../src/domain/evidenceErrors.js";

it.each([
  { input: "valid", cancel: true },
  { input: "valid", cancel: true, abortAtClose: 2 },
  { input: "valid", cancel: false },
  { input: "invalid-json", cancel: false },
  { input: "invalid-json", cancel: true },
  { input: "read-error", cancel: false },
  { input: "read-error", cancel: true },
  ...[
    { input: "invalid-provider-entry", cancel: false },
    { input: "invalid-provider-entry", cancel: true },
    { input: "invalid-workflow-entry", cancel: false },
    { input: "invalid-workflow-entry", cancel: true },
    { input: "invalid-header", cancel: false },
    { input: "invalid-header", cancel: true },
    { input: "duplicate-entries", cancel: false },
    { input: "duplicate-entries", cancel: true },
  ].flatMap((scenario) => [
    { ...scenario, padding: 0 },
    { ...scenario, padding: 9 * 1024 * 1024 },
  ]),
])(
  "retains $input primary and exact cleanup when final close fails (cancel=$cancel, padding=$padding)",
  async (scenario) => {
    const { input, cancel } = scenario;
    const root = await createTestTempDirectory("rea-snapshot-finalization-");
    const path = join(root, "snapshot.json");
    const session = createTestBinarySession(createCacheProvider([]));
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = new TypeError("caller-selected cancellation reason");
    try {
      const opened = await session.open(process.execPath);
      if (!opened.ok) throw opened.error;
      const exported = session.exportAnalysisSnapshot();
      if (!exported.ok) throw exported.error;
      const snapshot = exported.value;
      const encoded =
        input === "invalid-json"
          ? "{"
          : input === "duplicate-entries"
            ? `{"entries":[null],"workflow_entries":[null],${JSON.stringify(snapshot).slice(1)}`
            : JSON.stringify({
                ...snapshot,
                ...(input === "invalid-provider-entry"
                  ? { entries: [null] }
                  : {}),
                ...(input === "invalid-workflow-entry"
                  ? { workflow_entries: [null] }
                  : {}),
                ...(input === "invalid-header" ? { target: null } : {}),
              });
      await writeFile(
        path,
        `${" ".repeat("padding" in scenario ? scenario.padding : 0)}${encoded}`,
      );
      injected.path = resolve(path);
      injected.abortAtClose =
        "abortAtClose" in scenario ? scenario.abortAtClose : 1;
      injected.closeAttempts = 0;
      injected.failClose = true;
      injected.readFailure =
        input === "read-error"
          ? Object.assign(new Error("physical snapshot read failed"), {
              code: "EIO",
            })
          : undefined;
      injected.onClose = cancel ? () => controller.abort(reason) : undefined;
      const result = await readAnalysisSnapshot(
        path,
        controller.signal,
        resources,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected failed snapshot read");
      expect(result.error.cleanupIncomplete).toBe(true);
      const primary = result.error.cleanupPrimary;
      if ((input === "valid" || input === "duplicate-entries") && !cancel) {
        expect(primary).toBeUndefined();
      } else if (input === "valid" || input === "duplicate-entries") {
        expect(primary).toBeInstanceOf(AnalysisCancelledError);
        expect(primary?.cause).toBe(reason);
      } else if (
        input === "invalid-provider-entry" ||
        input === "invalid-workflow-entry" ||
        input === "invalid-header"
      ) {
        expect(primary).toBeInstanceOf(EvidenceIntegrityError);
        expect(primary?.cause).toBeInstanceOf(Error);
        expect(primary?.cause).not.toBe(reason);
      } else {
        expect(primary).toBeInstanceOf(EvidenceFileError);
        if (input === "read-error")
          expect(primary?.cause).toBe(injected.readFailure);
        expect(primary).toMatchObject({
          operation: "read",
          reason: input === "read-error" ? "io" : "invalid-json",
        });
      }
      expect(injected.handles[0]?.fd).toBeGreaterThanOrEqual(0);
      injected.failClose = false;
      await resources.retryCleanup();
      expect(injected.handles[0]?.fd).toBe(-1);
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      injected.failClose = false;
      injected.onClose = undefined;
      await resources.close();
      await session.close();
      injected.path = "";
      injected.readFailure = undefined;
      injected.handles = [];
    }
  },
);

it("keeps a caller abort reason opaque even when it resembles a file cleanup failure", async () => {
  const root = await createTestTempDirectory("rea-snapshot-opaque-abort-");
  const path = join(root, "foreign.json");
  await writeFile(path, "{}");
  const foreign = await open(path, "r");
  const owner = new OwnedFileHandle(foreign);
  const reason = new RegularFileCleanupFailure(
    path,
    owner,
    { kind: "completed", value: undefined },
    new Error("foreign close failure"),
  );
  const controller = new AbortController();
  controller.abort(reason);
  const resources = new ArtifactResourceScope();
  try {
    const result = await readAnalysisSnapshot(
      path,
      controller.signal,
      resources,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected typed cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(resources.hasPending).toBe(false);
    expect(foreign.fd).toBeGreaterThanOrEqual(0);
  } finally {
    await resources.close();
    await owner.close();
  }
});

const writeSnapshotInput = async (
  path: string,
  input: string,
  padding: number,
): Promise<{ readonly close: () => Promise<unknown> }> => {
  const session = createTestBinarySession(createCacheProvider([]));
  const opened = await session.open(process.execPath);
  if (!opened.ok) throw opened.error;
  const exported = session.exportAnalysisSnapshot();
  if (!exported.ok) throw exported.error;
  const encoded =
    input === "invalid-json"
      ? "{"
      : JSON.stringify({
          ...exported.value,
          ...(input === "invalid-provider-entry" ? { entries: [null] } : {}),
        });
  await writeFile(path, `${" ".repeat(padding)}${encoded}`);
  return session;
};

it.each(
  ["valid", "invalid-json", "invalid-provider-entry", "read-error"].flatMap(
    (input) =>
      [0, 1].flatMap((closeFailures) =>
        [0, 9 * 1024 * 1024].map((padding) => ({
          input,
          closeFailures,
          padding,
        })),
      ),
  ),
)(
  "retains $input primary when cancellation arrives during a close that releases (failed closes=$closeFailures, padding=$padding)",
  async ({ input, closeFailures, padding }) => {
    const root = await createTestTempDirectory("rea-snapshot-released-close-");
    const path = join(root, "snapshot.json");
    const session = await writeSnapshotInput(path, input, padding);
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = new TypeError("caller-selected cancellation reason");
    try {
      const before = await readFile(path);
      injected.path = resolve(path);
      injected.abortAtClose = 1;
      injected.closeAttempts = 0;
      injected.failCloseRemaining = closeFailures;
      injected.readFailure =
        input === "read-error"
          ? Object.assign(new Error("physical snapshot read failed"), {
              code: "EIO",
            })
          : undefined;
      injected.onClose = () => controller.abort(reason);
      const result = await readAnalysisSnapshot(
        path,
        controller.signal,
        resources,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected failed snapshot read");
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(injected.closeAttempts).toBe(closeFailures + 1);
      expect(injected.handles[0]?.fd).toBe(-1);
      expect(resources.hasPending).toBe(false);
      if (input === "valid") {
        expect(result.error).toBeInstanceOf(AnalysisCancelledError);
        expect(result.error.cause).toBe(reason);
      } else if (input === "invalid-provider-entry") {
        expect(result.error).toBeInstanceOf(EvidenceIntegrityError);
        expect(result.error.cause).not.toBe(reason);
      } else {
        expect(result.error).toBeInstanceOf(EvidenceFileError);
        expect(result.error).toMatchObject({
          operation: "read",
          reason: input === "read-error" ? "io" : "invalid-json",
        });
      }
      expect(await readFile(path)).toEqual(before);
    } finally {
      injected.failCloseRemaining = 0;
      injected.onClose = undefined;
      await resources.close();
      await session.close();
      injected.path = "";
      injected.readFailure = undefined;
      injected.handles = [];
    }
  },
);

it.each(["cleanup failure", "retained cleanup failure"] as const)(
  "keeps a caller abort reason shaped as a %s opaque when it arrives after final close",
  async (shape) => {
    const root = await createTestTempDirectory("rea-snapshot-late-opaque-");
    const path = join(root, "snapshot.json");
    const foreignPath = join(root, "foreign.json");
    await writeFile(foreignPath, "{}");
    const foreign = await open(foreignPath, "r");
    const foreignOwner = new OwnedFileHandle(foreign);
    const session = await writeSnapshotInput(path, "valid", 0);
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const shaped = new RegularFileCleanupFailure(
      foreignPath,
      foreignOwner,
      { kind: "completed", value: undefined },
      new Error("foreign close failure"),
    );
    let reason: unknown = shaped;
    if (shape === "retained cleanup failure") {
      // A foreign scope owns this lease; the snapshot read must not adopt it.
      const attempt = await new ArtifactResourceScope().release({
        kind: "file-handle",
        resource: foreignPath,
        handle: new OwnedFileHandle({
          fd: 99,
          close: async () => {
            throw new Error("foreign retained close failure");
          },
        } as never),
      });
      if (attempt.kind !== "failed")
        throw new Error("Expected a retained foreign owner");
      reason = new RegularFileRetainedCleanupFailure(shaped, attempt.lease, {
        reason: "foreign retained close failure",
        resources: [foreignPath],
      });
    }
    try {
      injected.path = resolve(path);
      injected.closeAttempts = 0;
      injected.afterClose = () => controller.abort(reason);
      const result = await readAnalysisSnapshot(
        path,
        controller.signal,
        resources,
      );
      expect(controller.signal.aborted).toBe(true);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected typed cancellation");
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(resources.hasPending).toBe(false);
      expect(injected.handles[0]?.fd).toBe(-1);
      expect(foreign.fd).toBeGreaterThanOrEqual(0);
    } finally {
      injected.afterClose = undefined;
      injected.path = "";
      injected.handles = [];
      await resources.close();
      await session.close();
      await foreignOwner.close();
    }
  },
);
