import {
  mkdir,
  lstat as fsLstat,
  open as fsOpen,
  opendir as fsOpendir,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Dirent } from "node:fs";

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { importReferenceSource } from "../../../src/application/ReferenceSourceImport.js";
import { referenceSourceImportAnalysisError } from "../../../src/application/ReferenceSourceImportTypes.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { readReferenceSource } from "../../../src/reference/ReferenceSourceReader.js";
import * as directoryValidation from "../../../src/reference/ReferenceSourceReaderValidate.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { err, ok } from "../../../src/domain/result.js";
import { phaseArrival, phaseGate } from "../../support/lifecycleHarness.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    lstat: vi.fn(actual.lstat),
    opendir: vi.fn(actual.opendir),
  };
});

const openMock = vi.mocked(fsOpen);
const lstatMock = vi.mocked(fsLstat);
const opendirMock = vi.mocked(fsOpendir);
let actual: typeof import("node:fs/promises");

interface DirectoryOperations {
  read(): Promise<Dirent | null>;
  close(): Promise<void>;
}

beforeEach(async () => {
  actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  openMock.mockImplementation((...args) => actual.open(...args));
  lstatMock.mockImplementation((...args) => actual.lstat(...args));
  opendirMock.mockImplementation((...args) => actual.opendir(...args));
});

afterEach(() => {
  openMock.mockReset();
  lstatMock.mockReset();
  opendirMock.mockReset();
});

it.each([
  "root-admission",
  "directory-validation",
  "entry-metadata",
  "file-finalization",
] as const)(
  "retains physical metadata failure during cancellation at %s",
  async (phase) => {
    const root = await createTestTempDirectory("rea-reference-metadata-abort-");
    const file = join(root, "source.ts");
    if (phase === "entry-metadata" || phase === "file-finalization")
      await writeFile(file, "observed");
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close());
    const controller = new AbortController();
    const physical = Object.assign(new Error("authored metadata EIO"), {
      code: "EIO",
    });
    let armed = phase === "root-admission";
    if (phase === "file-finalization")
      openMock.mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
          const result = await read(...readArgs);
          if (result.bytesRead === 0) armed = true;
          return result;
        });
        return handle;
      });
    lstatMock.mockImplementation(async (...args) => {
      if (!armed || (phase === "entry-metadata" && String(args[0]) !== file))
        return actual.lstat(...args);
      controller.abort("during failed metadata lookup");
      throw physical;
    });
    const result = await readReferenceSource(root, resources, {
      signal: controller.signal,
      beforeDirectory: async () => {
        if (phase !== "file-finalization") armed = true;
        return ok(undefined);
      },
    });
    if (result.ok) throw new Error("Metadata failure was ignored");
    if (phase === "root-admission") {
      expect(result.error).toMatchObject({ code: "io", cause: physical });
    } else if (phase === "directory-validation") {
      expect(result.error.code).toBe("cancelled");
      expect(result.error.partial?.rootFailure).toMatchObject({
        code: "io",
        message: expect.stringContaining("EIO"),
      });
    } else {
      expect(result.error.code).toBe("cancelled");
      expect(result.error.partial?.entries).toContainEqual(
        expect.objectContaining({ path: "source.ts", code: "io" }),
      );
    }
  },
);

it.each([
  ["refusal", false],
  ["refusal", true],
  ["cancel-after-policy", false],
  ["cancel-after-policy", true],
  ["refusal-late-cancel", true],
] as const)(
  "owns directory cleanup before policy %s (close fails=%s)",
  async (outcome, closeFails) => {
    const root = await createTestTempDirectory("rea-reference-policy-owner-");
    await writeFile(join(root, "unexamined.ts"), "export const value = 1;\n");
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close().catch(() => undefined));
    const controller = new AbortController();
    const reason = new Error("cancelled at the policy boundary");
    const policyCause = new Error("scoped policy read failed");
    const closeFailure = new Error("directory close rejected after policy");
    let closeCalls = 0;
    let readCalls = 0;
    opendirMock.mockImplementation(async (...args) => {
      const directory = await actual.opendir(...args);
      const operations: DirectoryOperations = directory;
      const read = operations.read.bind(directory);
      vi.spyOn(operations, "read").mockImplementation(async () => {
        readCalls += 1;
        return read();
      });
      const close = operations.close.bind(directory);
      vi.spyOn(operations, "close").mockImplementation(async () => {
        closeCalls += 1;
        if (outcome === "refusal-late-cancel") controller.abort(reason);
        await close();
        if (closeFails) throw closeFailure;
      });
      return directory;
    });
    const result = await readReferenceSource(root, resources, {
      signal: controller.signal,
      beforeDirectory: async () => {
        expect(opendirMock).toHaveBeenCalledTimes(1);
        if (outcome === "cancel-after-policy") {
          controller.abort(reason);
          return ok(undefined);
        }
        return err({
          tag: "reference-source-reader",
          code: "io",
          message: "Scoped policy could not be read",
          cause: policyCause,
        });
      },
    });
    if (result.ok) throw new Error("Policy outcome was ignored");
    expect(result.error.code).toBe(
      outcome === "cancel-after-policy" ? "cancelled" : "io",
    );
    if (outcome !== "cancel-after-policy") {
      expect(result.error.message).toBe("Scoped policy could not be read");
      expect(result.error.cause).toBe(policyCause);
    }
    expect(result.error.partial).toMatchObject({ entries: [], bytesRead: 0 });
    expect(readCalls).toBe(0);
    expect(openMock).not.toHaveBeenCalled();
    expect(closeCalls).toBe(1);
    expect(resources.hasPending).toBe(closeFails);
    if (closeFails) {
      expect(result.error.cleanup).toEqual({
        resources: [root],
        reason: expect.stringContaining(closeFailure.message),
      });
      await expect(resources.close()).rejects.toMatchObject({
        cleanup: { resources: [root] },
      });
    } else {
      expect(result.error.cleanup).toBeUndefined();
      await resources.close();
    }
    expect(closeCalls).toBe(1);
  },
);

it.each([false, true])(
  "preserves admission EIO and retains its failed-close owner (cancelled=%s)",
  async (cancelled) => {
    const root = await createTestTempDirectory(
      "rea-reference-admission-owner-",
    );
    const file = join(root, "source.ts");
    await writeFile(file, "export const answer = 42;\n");
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close().catch(() => undefined));
    const statFailure = Object.assign(new Error("injected admission EIO"), {
      code: "EIO",
    });
    const closeFailure = new Error("native close rejected after invalidation");
    const controller = new AbortController();
    let closeCalls = 0;

    openMock.mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        if (cancelled) controller.abort("during failed admission");
        throw statFailure;
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeCalls += 1;
        await close();
        throw closeFailure;
      });
      return handle;
    });

    const result = await readReferenceSource(root, resources, {
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        tag: "reference-source-reader",
        code: "io",
        message: expect.stringContaining("EIO"),
        cleanup: {
          resources: [file],
          reason: expect.stringContaining(closeFailure.message),
        },
        partial: {
          entries: [
            {
              status: "failed",
              kind: "file",
              path: "source.ts",
              code: "io",
              message: expect.stringContaining("EIO"),
            },
          ],
        },
      },
    });
    expect(closeCalls).toBe(1);

    await expect(resources.close()).rejects.toMatchObject({
      cleanup: {
        resources: [file],
        reason: expect.stringContaining(closeFailure.message),
      },
    });
    expect(closeCalls).toBe(1);
  },
);

const assertSourceCleanupRetry = async (enclosingGit: boolean) => {
  const workspace = await createTestTempDirectory("rea-reference-file-owner-");
  const root = join(workspace, "source");
  await mkdir(root);
  if (enclosingGit) {
    const gitDirectory = join(workspace, ".git");
    await mkdir(gitDirectory);
    await writeFile(
      join(gitDirectory, "HEAD"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );
  }
  const file = join(root, "source.ts");
  const bytes = "export const answer = 'retained';\n";
  await writeFile(file, bytes);
  const resources = new ArtifactResourceScope();
  const closeFailure = new Error("injected close before native close");
  let allowClose = false;
  onTestFinished(async () => {
    allowClose = true;
    await resources.close().catch(() => undefined);
  });
  let closeCalls = 0;
  let openCalls = 0;
  let sourceHandle: FileHandle | undefined;

  openMock.mockImplementation(async (...args) => {
    if (args[0] !== file) return actual.open(...args);
    openCalls += 1;
    const handle = await actual.open(...args);
    sourceHandle = handle;
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closeCalls += 1;
      if (!allowClose) throw closeFailure;
      await close();
    });
    return handle;
  });

  const first = await importReferenceSource(
    {
      root,
      caller: "reference-source-cleanup-owner-test",
      policy: { secretPatterns: [] },
    },
    resources,
  );
  expect(first).toMatchObject({
    ok: false,
    error: {
      code: "io",
      cleanup: {
        resources: [file],
        reason: expect.stringContaining(closeFailure.message),
      },
      partial: {
        entries: [
          {
            status: "read",
            kind: "file",
            path: "source.ts",
            bytes: Buffer.from(bytes),
          },
        ],
        bytesRead: Buffer.byteLength(bytes),
      },
    },
  });
  expect(openCalls).toBe(1);
  expect(closeCalls).toBe(1);
  expect(sourceHandle?.fd).toBeGreaterThanOrEqual(0);

  const blocked = await readReferenceSource(root, resources);
  expect(blocked).toMatchObject({
    ok: false,
    error: {
      code: "io",
      cleanup: { resources: [file] },
    },
  });
  expect(openCalls).toBe(1);
  expect(closeCalls).toBe(2);
  expect(sourceHandle?.fd).toBeGreaterThanOrEqual(0);

  allowClose = true;
  await resources.close();
  expect(openCalls).toBe(1);
  expect(closeCalls).toBe(3);
  expect(sourceHandle?.fd).toBe(-1);
};

it.each([false, true])(
  "retains partial file bytes and retries the same live owner before new work (enclosing Git repository: %s)",
  assertSourceCleanupRetry,
);

it.each([
  [false, false, "reader"],
  [false, true, "reader"],
  [true, false, "reader"],
  [true, true, "reader"],
  [true, false, "import"],
  [true, true, "import"],
] as const)(
  "preserves directory EIO through close (late cancellation=%s, close fails=%s, surface=%s)",
  async (lateCancellation, closeFails, surface) => {
    const root = await createTestTempDirectory(
      "rea-reference-directory-read-owner-",
    );
    const file = join(root, "source.ts");
    const bytes = "observed before directory EIO\n";
    await writeFile(file, bytes);
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close().catch(() => undefined));
    const readFailure = Object.assign(new Error("injected directory EIO"), {
      code: "EIO",
    });
    const closeFailure = new Error(
      "directory close rejected after invalidation",
    );
    const controller = new AbortController();
    const reason = { selected: "after directory read failed" };
    let readCalls = 0;
    let closeCalls = 0;

    opendirMock.mockImplementation(async (...args) => {
      const directory = await actual.opendir(...args);
      const operations: DirectoryOperations = directory;
      const read = operations.read.bind(directory);
      vi.spyOn(operations, "read").mockImplementation(async () => {
        if (readCalls++ > 0) throw readFailure;
        return read();
      });
      const close = operations.close.bind(directory);
      vi.spyOn(operations, "close").mockImplementation(async () => {
        closeCalls += 1;
        if (lateCancellation) controller.abort(reason);
        await close();
        if (closeFails) throw closeFailure;
      });
      return directory;
    });

    const result =
      surface === "reader"
        ? await readReferenceSource(root, resources, {
            signal: controller.signal,
          })
        : await importReferenceSource(
            {
              root,
              caller: "reference-cancellation-test",
              policy: { secretPatterns: [] },
              signal: controller.signal,
            },
            resources,
          );
    if (result.ok)
      throw new Error("Directory and cleanup failures were ignored");
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "io",
        message: expect.stringContaining(readFailure.message),
        ...(closeFails
          ? {
              cleanup: {
                resources: [root],
                reason: expect.stringContaining(closeFailure.message),
              },
            }
          : {}),
        partial: {
          bytesRead: Buffer.byteLength(bytes),
        },
      },
    });
    if (lateCancellation)
      expect(result.error.secondaryCancellation?.cause).toBe(reason);
    expect(result.error.cause).toBe(readFailure);
    if (
      surface === "import" &&
      result.error.tag === "reference-source-import"
    ) {
      const projected = projectAnalysisError(
        referenceSourceImportAnalysisError(result.error),
      );
      expect(projected.details?.secondary_failures).toEqual([
        expect.objectContaining({ category: "cancelled" }),
      ]);
    }
    expect(result.error.partial?.entries).toContainEqual(
      expect.objectContaining({
        status: "read",
        kind: "file",
        path: "source.ts",
        bytes: Buffer.from(bytes),
      }),
    );
    expect(result.error.partial?.rootFailure).toEqual({
      code: "io",
      message: expect.stringContaining(readFailure.message),
    });
    expect(closeCalls).toBe(1);

    if (closeFails)
      await expect(resources.close()).rejects.toMatchObject({
        cleanup: {
          resources: [root],
          reason: expect.stringContaining(closeFailure.message),
        },
      });
    else {
      expect(result.error.cleanup).toBeUndefined();
      await resources.close();
    }
    expect(closeCalls).toBe(1);
  },
);

it("keeps cancelled traversal typed when native directory close rejects after invalidation", async () => {
  const root = await createTestTempDirectory("rea-reference-directory-owner-");
  await mkdir(join(root, "child"));
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close().catch(() => undefined));
  const controller = new AbortController();
  const closeFailure = new Error("native directory close rejected");
  let closeCalls = 0;
  let openedPath: string | undefined;

  opendirMock.mockImplementation(async (...args) => {
    const directory = await actual.opendir(...args);
    const operations: DirectoryOperations = directory;
    openedPath = String(args[0]);
    const read = operations.read.bind(directory);
    vi.spyOn(operations, "read").mockImplementation(async () => {
      const child = await read();
      if (child !== null) controller.abort();
      return child;
    });
    const close = operations.close.bind(directory);
    vi.spyOn(operations, "close").mockImplementation(async () => {
      closeCalls += 1;
      await close();
      throw closeFailure;
    });
    return directory;
  });

  const result = await readReferenceSource(root, resources, {
    signal: controller.signal,
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "cancelled",
      cleanup: {
        resources: [root],
        reason: expect.stringContaining(closeFailure.message),
      },
      partial: { entries: [] },
    },
  });
  expect(openedPath).toBe(root);
  expect(closeCalls).toBe(1);

  await expect(resources.close()).rejects.toMatchObject({
    cleanup: {
      resources: [root],
      reason: expect.stringContaining(closeFailure.message),
    },
  });
  expect(closeCalls).toBe(1);
});

it("preserves null cancellation and retained directory cleanup across retry", async () => {
  const root = await createTestTempDirectory("rea-reference-null-close-");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close().catch(() => undefined));
  const controller = new AbortController();
  const closeFailure = new Error("directory close temporarily denied");
  let closeCalls = 0;
  let releaseFixture: (() => Promise<void>) | undefined;
  onTestFinished(() => releaseFixture?.());
  opendirMock.mockImplementation(async (...args) => {
    const directory = await actual.opendir(...args);
    const operations: DirectoryOperations = directory;
    const close = operations.close.bind(directory);
    releaseFixture = close;
    vi.spyOn(operations, "close").mockImplementation(async () => {
      closeCalls += 1;
      if (closeCalls === 1) throw closeFailure;
      await close();
    });
    return directory;
  });
  const result = await readReferenceSource(root, resources, {
    signal: controller.signal,
    beforeDirectory: async () => {
      controller.abort(null);
      return ok(undefined);
    },
  });
  if (result.ok) throw new Error("Expected cancellation and cleanup failure");
  expect(result.error.code).toBe("cancelled");
  expect(result.error.cause).toBeNull();
  expect(result.error.cleanup).toEqual({
    resources: [root],
    reason: expect.stringContaining(closeFailure.message),
  });
  expect(result.error.partial).toMatchObject({ entries: [], bytesRead: 0 });
  expect(resources.hasPending).toBe(true);
  expect(resources.cleanupResources).toEqual([root]);
  expect(closeCalls).toBe(1);
  await expect(resources.close()).rejects.toMatchObject({
    cleanup: {
      resources: [root],
      reason: expect.stringContaining(closeFailure.message),
    },
  });
  expect(resources.hasPending).toBe(true);
  expect(resources.cleanupResources).toEqual([root]);
  expect(closeCalls).toBe(1);
});

const observeDirectoryValidation = (
  started: (path: string) => Promise<void> | undefined,
  finished?: (path: string) => void,
) => {
  const validate = directoryValidation.validateDirectory;
  const spy = vi
    .spyOn(directoryValidation, "validateDirectory")
    .mockImplementation(async (...args) => {
      const path = args[2];
      const validation = validate(...args);
      const hold = started(path);
      const result = await validation;
      await hold;
      finished?.(path);
      return result;
    });
  onTestFinished(() => {
    spy.mockRestore();
  });
};

it("runs directory policy in traversal order when prefetched admissions finish out of order", async () => {
  const root = await createTestTempDirectory("rea-reference-ordered-");
  for (const name of ["a", "b"]) await mkdir(join(root, name));
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const listed: string[] = [];
  const policy: string[] = [];
  const firstAdmission = phaseGate();
  const laterValidated = phaseArrival();
  observeDirectoryValidation(
    (path) =>
      dirname(path) === root && basename(path) === listed[0]
        ? firstAdmission.hold()
        : undefined,
    (path) => {
      if (dirname(path) === root && basename(path) === listed[1])
        laterValidated.arrive();
    },
  );
  const read = readReferenceSource(root, resources, {
    shouldExclude: (path, kind) => {
      if (kind === "directory") listed.push(path);
      return false;
    },
    beforeDirectory: async (path) => {
      policy.push(path);
      return path === "."
        ? ok(undefined)
        : err({
            tag: "reference-source-reader",
            code: "io",
            message: `refused ${path}`,
          });
    },
  });
  try {
    await firstAdmission.reached(read, "first directory admission blocked");
    await laterValidated.reached(read, "later directory admission completed");
  } finally {
    firstAdmission.release();
    await read;
  }
  expect(policy).toEqual([".", listed[0]]);
  expect(await read).toMatchObject({
    ok: false,
    error: { code: "io", message: `refused ${listed[0]}` },
  });
});

it("settles every lookup started ahead of its turn before a cancelled read returns", async () => {
  const root = await createTestTempDirectory("rea-reference-settled-");
  for (const name of ["a", "b"]) await mkdir(join(root, name));
  await writeFile(join(root, "source.ts"), "observed");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const listed: string[] = [];
  const siblingAdmission = phaseGate();
  const childPolicy = phaseGate();
  const childClosed = phaseArrival();
  const rootRevalidated = phaseArrival();
  let rootValidations = 0;
  observeDirectoryValidation(
    (path) =>
      dirname(path) === root && basename(path) === listed[1]
        ? siblingAdmission.hold()
        : undefined,
    (path) => {
      if (path === root && ++rootValidations === 2) rootRevalidated.arrive();
    },
  );
  opendirMock.mockImplementation(async (...args) => {
    const directory = await actual.opendir(...args);
    if (dirname(String(args[0])) === root) {
      const operations: DirectoryOperations = directory;
      const close = operations.close.bind(directory);
      vi.spyOn(operations, "close").mockImplementation(async () => {
        await close();
        childClosed.arrive();
      });
    }
    return directory;
  });
  const controller = new AbortController();
  const reason = { requested: "stop at the first child" };
  let settled = false;
  const read = readReferenceSource(root, resources, {
    signal: controller.signal,
    shouldExclude: (path, kind) => {
      if (kind === "directory") listed.push(path);
      return false;
    },
    beforeDirectory: async (path) => {
      if (path !== ".") await childPolicy.hold();
      return ok(undefined);
    },
  }).then((result) => {
    settled = true;
    return result;
  });
  try {
    await siblingAdmission.reached(read, "prefetched sibling lookup blocked");
    await childPolicy.reached(read, "first child opened");
    await rootRevalidated.reached(read, "root closing admission completed");
    controller.abort(reason);
    childPolicy.release();
    await childClosed.reached(read, "cancelled child handle closed");
    await nextTurn();
    expect(settled).toBe(false);
  } finally {
    siblingAdmission.release();
    childPolicy.release();
    await read;
  }
  const result = await read;
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error.code).toBe("cancelled");
  expect(result.error.cause).toBe(reason);
  expect(result.error.partial?.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "source.ts", status: "read" }),
    ]),
  );
});

// Descent buries older siblings whose admissions are still running.
it("bounds running directory admissions while slow siblings are buried by deeper levels", async () => {
  const root = await createTestTempDirectory("rea-reference-bounded-");
  // Every top-level child can be listed first. Give each enough descendants to
  // bury the held siblings without choosing or mocking native listing order.
  const names = ["a", "b", "c", "d"];
  await Promise.all(
    names.flatMap((parent) =>
      names.flatMap((child) =>
        names.map((leaf) =>
          mkdir(join(root, parent, child, leaf), { recursive: true }),
        ),
      ),
    ),
  );
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const siblings = phaseGate();
  const descended = phaseArrival();
  let started = 0;
  const seenParents = new Set<string>();
  const heldSiblings = new Set<string>();
  observeDirectoryValidation((path) => {
    if (!heldSiblings.has(path)) return;
    started += 1;
    return siblings.hold();
  });
  const read = readReferenceSource(root, resources, {
    shouldExclude: (path, kind) => {
      if (kind === "directory") {
        const child = join(root, path);
        const parent = dirname(child);
        if (seenParents.has(parent)) heldSiblings.add(child);
        seenParents.add(parent);
      }
      return false;
    },
    beforeDirectory: async (path) => {
      if (path.split("/").length === 3) descended.arrive();
      return ok(undefined);
    },
  });
  try {
    await descended.reached(read, "third level admitted with siblings held");
    // All counted admissions remain held, so started is also their peak.
    // Each held path is a pending sibling, outside the active descent.
    expect(started).toBeGreaterThan(1);
    expect(started).toBeLessThanOrEqual(4);
  } finally {
    siblings.release();
    await read;
  }
  const result = await read;
  if (!result.ok) throw result.error;
  expect(result.value.entries).toHaveLength(
    names.length + names.length ** 2 + names.length ** 3,
  );
});
