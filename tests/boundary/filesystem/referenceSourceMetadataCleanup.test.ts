import {
  mkdir,
  lstat as fsLstat,
  open as fsOpen,
  opendir as fsOpendir,
  realpath as fsRealpath,
  stat as fsStat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { constants } from "node:fs";

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { importReferenceSource } from "../../../src/application/ReferenceSourceImport.js";
import { readReferenceSourceVcs } from "../../../src/application/ReferenceSourceVcsAdapter.js";
import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
    stat: vi.fn(actual.stat),
    realpath: vi.fn(actual.realpath),
    opendir: vi.fn(actual.opendir),
  };
});

const lstatMock = vi.mocked(fsLstat);
const openMock = vi.mocked(fsOpen);
const opendirMock = vi.mocked(fsOpendir);
const statMock = vi.mocked(fsStat);
const realpathMock = vi.mocked(fsRealpath);
let actual: typeof import("node:fs/promises");

beforeEach(async () => {
  actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  lstatMock.mockImplementation((...args) => actual.lstat(...args));
  openMock.mockImplementation((...args) => actual.open(...args));
  opendirMock.mockImplementation((...args) => actual.opendir(...args));
  statMock.mockImplementation((...args) => actual.stat(...args));
  realpathMock.mockImplementation((...args) => actual.realpath(...args));
});

afterEach(() => {
  lstatMock.mockReset();
  openMock.mockReset();
  opendirMock.mockReset();
  statMock.mockReset();
  realpathMock.mockReset();
});

const failCloseUntilAllowed = (
  target: string,
): { readonly allow: () => void; readonly calls: () => number } => {
  const closeFailure = new Error("injected metadata close failure");
  let allowClose = false;
  let closeCalls = 0;
  openMock.mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (resolve(String(args[0])) !== resolve(target)) return handle;
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closeCalls += 1;
      if (!allowClose) throw closeFailure;
      await close();
    });
    return handle;
  });
  return {
    allow: () => {
      allowClose = true;
    },
    calls: () => closeCalls,
  };
};

const createPackedRefRepository = async () => {
  const root = await createTestTempDirectory("rea-reference-packed-owner-");
  await execFileOutput("git", ["init", "--initial-branch=main"], { cwd: root });
  await writeFile(join(root, "main.ts"), "export const value = 1;\n");
  await execFileOutput(
    "git",
    [
      "-c",
      "user.name=REA fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  const head = (
    await execFileOutput("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  await execFileOutput("git", ["pack-refs", "--all", "--prune"], {
    cwd: root,
  });
  const looseRef = join(root, ".git", "refs", "heads", "main");
  const packedRefs = join(root, ".git", "packed-refs");
  await actual.mkdir(join(root, ".git", "refs", "heads"), {
    recursive: true,
  });
  await writeFile(looseRef, `${head}\n`);
  return { root, looseRef, packedRefs };
};

it.each([".", "nested"])(
  "retains failed %s/.gitignore cleanup under the caller's scope",
  async (directory) => {
    const root = await createTestTempDirectory("rea-reference-ignore-owner-");
    await mkdir(join(root, directory), { recursive: true });
    const path = join(root, directory, ".gitignore");
    await writeFile(path, "generated/\n");
    const resources = new ArtifactResourceScope();
    const close = failCloseUntilAllowed(path);
    onTestFinished(async () => {
      close.allow();
      await resources.close().catch(() => undefined);
    });

    const result = await importReferenceSource(
      {
        root,
        caller: "reference-source-metadata-cleanup-test",
        policy: { secretPatterns: [] },
      },
      resources,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "io",
        cleanup: {
          resources: [path],
          reason: expect.stringContaining("injected metadata close failure"),
        },
      },
    });
    expect(close.calls()).toBe(2);

    close.allow();
    await resources.close();
    expect(close.calls()).toBe(3);
  },
);

it("retains local Git configuration cleanup before trusting ignore policy", async () => {
  const root = await createTestTempDirectory("rea-reference-config-owner-");
  await execFileOutput("git", ["init", "--initial-branch=main"], { cwd: root });
  const path = join(root, ".git", "config");
  const resources = new ArtifactResourceScope();
  const close = failCloseUntilAllowed(path);
  onTestFinished(async () => {
    close.allow();
    await resources.close().catch(() => undefined);
  });
  const result = await importReferenceSource(
    {
      root,
      caller: "reference-source-config-cleanup-test",
      policy: { secretPatterns: [] },
    },
    resources,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { code: "io", cleanup: { resources: [path] } },
  });
  expect(close.calls()).toBe(2);
  close.allow();
  await resources.close();
  expect(close.calls()).toBe(3);
});

it("preserves Git metadata cleanup failure and the completed source read", async () => {
  const root = await createTestTempDirectory("rea-reference-head-owner-");
  const repository = join(root, "repository");
  const sourceRoot = join(root, "source");
  await Promise.all([mkdir(repository), mkdir(sourceRoot)]);
  await execFileOutput("git", ["init", "--initial-branch=main"], {
    cwd: repository,
  });
  const source = join(sourceRoot, "main.ts");
  const bytes = "export const value = 1;\n";
  await writeFile(source, bytes);
  await writeFile(join(sourceRoot, ".git"), "gitdir: ../repository/.git\n");
  const head = join(repository, ".git", "HEAD");
  const resources = new ArtifactResourceScope();
  const close = failCloseUntilAllowed(head);
  onTestFinished(async () => {
    close.allow();
    await resources.close().catch(() => undefined);
  });

  const result = await importReferenceSource(
    {
      root: sourceRoot,
      excludePaths: [".git"],
      caller: "reference-source-metadata-cleanup-test",
      policy: { secretPatterns: [] },
    },
    resources,
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "io",
      cleanup: {
        resources: [head],
        reason: expect.stringContaining("injected metadata close failure"),
      },
      partial: {
        entries: [
          {
            kind: "file",
            path: "main.ts",
            bytes: Buffer.from(bytes),
          },
        ],
      },
    },
  });
  expect(close.calls()).toBe(2);

  close.allow();
  await resources.close();
  expect(close.calls()).toBe(3);
});

it("retains later packed-ref cleanup after an earlier loose-ref read failure", async () => {
  const { root, looseRef, packedRefs } = await createPackedRefRepository();

  const resources = new ArtifactResourceScope();
  let allowClose = false;
  let looseReadFailed = false;
  const packedCloseCalls = new Map<object, number>();
  openMock.mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    const path = resolve(String(args[0]));
    if (path === resolve(looseRef)) {
      vi.spyOn(handle, "read").mockImplementation(async () => {
        looseReadFailed = true;
        throw Object.assign(new Error("injected loose ref EIO"), {
          code: "EIO",
        });
      });
    }
    if (path === resolve(packedRefs)) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        packedCloseCalls.set(handle, (packedCloseCalls.get(handle) ?? 0) + 1);
        if (!allowClose) throw new Error("injected packed-refs close failure");
        await close();
      });
    }
    return handle;
  });
  onTestFinished(async () => {
    allowClose = true;
    await resources.close().catch(() => undefined);
  });

  const result = await readReferenceSourceVcs(root, resources);
  expect(looseReadFailed).toBe(true);
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "io",
      cleanup: {
        resources: [packedRefs],
        reason: expect.stringContaining("injected packed-refs close failure"),
      },
    },
  });
  expect([...packedCloseCalls.values()]).toEqual(
    Array.from({ length: packedCloseCalls.size }, () => 2),
  );

  allowClose = true;
  await resources.close();
  expect([...packedCloseCalls.values()]).toEqual(
    Array.from({ length: packedCloseCalls.size }, () => 3),
  );
});

it("keeps a later packed-ref read error primary over earlier loose-ref cleanup", async () => {
  const { root, looseRef, packedRefs } = await createPackedRefRepository();
  const resources = new ArtifactResourceScope();
  let allowClose = false;
  const looseCloseCalls = new Map<object, number>();
  openMock.mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    const path = resolve(String(args[0]));
    if (path === resolve(looseRef)) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        looseCloseCalls.set(handle, (looseCloseCalls.get(handle) ?? 0) + 1);
        if (!allowClose) throw new Error("injected loose ref close failure");
        await close();
      });
    }
    if (path === resolve(packedRefs))
      vi.spyOn(handle, "read").mockImplementation(async () => {
        throw Object.assign(new Error("injected packed-refs EIO"), {
          code: "EIO",
        });
      });
    return handle;
  });
  onTestFinished(async () => {
    allowClose = true;
    await resources.close().catch(() => undefined);
  });

  const result = await readReferenceSourceVcs(root, resources);
  if (result.ok) throw new Error("Expected Git metadata read to fail");
  expect(result.error.message).toContain("injected packed-refs EIO");
  expect(result.error.message).not.toContain(
    "injected loose ref close failure",
  );
  expect(result.error.cleanup).toMatchObject({
    resources: [looseRef],
    reason: expect.stringContaining("injected loose ref close failure"),
  });
  expect([...looseCloseCalls.values()]).toEqual(
    Array.from({ length: looseCloseCalls.size }, () => 2),
  );

  allowClose = true;
  await resources.close();
  expect([...looseCloseCalls.values()]).toEqual(
    Array.from({ length: looseCloseCalls.size }, () => 3),
  );
});

it.each([
  ["stat", false],
  ["stat", true],
  ["realpath", false],
  ["realpath", true],
] as const)(
  "preserves a physical root %s failure when cancellation arrives (same reason: %s)",
  async (stage, sameReason) => {
    const root = await createTestTempDirectory("rea-reference-root-eio-");
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const physical = Object.assign(new Error(`root ${stage} failed`), {
      code: "EIO",
    });
    const reason = sameReason ? physical : { source: "caller" };
    const reject = (): never => {
      controller.abort(reason);
      throw physical;
    };
    if (stage === "stat") {
      statMock.mockImplementation(async (...args) => {
        if (String(args[0]) === root) return reject();
        return actual.stat(...args);
      });
    } else {
      realpathMock.mockImplementation(async (...args) => {
        if (String(args[0]) === root) return reject();
        return actual.realpath(...args);
      });
    }
    try {
      const result = await importReferenceSource(
        {
          root,
          caller: "test",
          policy: { secretPatterns: [] },
          signal: controller.signal,
        },
        resources,
      );
      if (result.ok)
        throw new Error("Expected physical root admission failure");
      expect(result.error.code).toBe("io");
      expect(result.error.cause).toBe(physical);
      expect(result.error.secondaryCancellation?.cause).toBe(reason);
    } finally {
      await resources.close();
    }
  },
);

it.each([
  { closeFails: false, sameReason: false },
  { closeFails: false, sameReason: true },
  { closeFails: true, sameReason: false },
  { closeFails: true, sameReason: true },
])(
  "retains physical Git read failure through late cancellation (close fails: $closeFails, same reason: $sameReason)",
  async ({ closeFails, sameReason }) => {
    const root = await createTestTempDirectory("rea-reference-vcs-eio-");
    const gitdir = join(root, ".git");
    await mkdir(gitdir);
    const head = join(gitdir, "HEAD");
    await writeFile(head, "ref: refs/heads/main\n");
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = { source: "caller" };
    let physical: unknown;
    const handles: FileHandle[] = [];
    let allowClose = false;
    openMock.mockImplementation(async (...args) => {
      if (resolve(String(args[0])) !== resolve(head))
        return actual.open(...args);
      const flags = args[1];
      if (typeof flags !== "number")
        throw new Error("Expected numeric regular-file admission flags");
      // Preserve admission flags; neither O_TRUNC nor a write is used.
      const handle = await actual.open(
        args[0],
        flags | constants.O_WRONLY,
        args[2],
      );
      handles.push(handle);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        try {
          return await read(...readArgs);
        } catch (cause: unknown) {
          physical = cause;
          throw cause;
        }
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        controller.abort(sameReason ? physical : reason);
        if (closeFails && !allowClose) throw new Error("close failed");
        await close();
      });
      return handle;
    });
    try {
      const result = await readReferenceSourceVcs(
        root,
        resources,
        controller.signal,
      );
      expect(physical).toMatchObject({ code: "EBADF" });
      const cancellation = sameReason ? physical : reason;
      expect(controller.signal.reason).toBe(cancellation);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "io",
          secondaryCancellation: { cause: cancellation },
          ...(closeFails ? { cleanup: { resources: [head] } } : {}),
        },
      });
      if (result.ok) throw new Error("Physical metadata failure was ignored");
      expect(result.error.secondaryCancellation?.cause).toBe(cancellation);
      expect(resources.cleanupResources).toEqual(closeFails ? [head] : []);
      let retained: unknown = result.error.cause;
      while (
        retained !== physical &&
        retained instanceof Error &&
        retained.cause !== undefined
      )
        retained = retained.cause;
      expect(retained).toBe(physical);
      expect(
        handles.every((handle) =>
          closeFails ? handle.fd >= 0 : handle.fd === -1,
        ),
      ).toBe(true);
      allowClose = true;
      await resources.close();
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      expect(resources.hasPending).toBe(false);
    } finally {
      allowClose = true;
      await resources.close();
    }
  },
);

it.each([false, true])(
  "preserves a policy read failure and later cancellation (close fails: %s)",
  async (closeFails) => {
    const root = await createTestTempDirectory("rea-reference-policy-eio-");
    const policyPath = join(root, ".gitignore");
    await writeFile(policyPath, "ignored\n");
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = { source: "caller" };
    const physical = Object.assign(new Error("policy read failed"), {
      code: "EIO",
    });
    let allowClose = false;
    openMock.mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (resolve(String(args[0])) !== resolve(policyPath)) return handle;
      vi.spyOn(handle, "read").mockImplementation(async () => {
        throw physical;
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        controller.abort(reason);
        if (closeFails && !allowClose) throw new Error("close failed");
        await close();
      });
      return handle;
    });
    try {
      const result = await importReferenceSource(
        {
          root,
          caller: "test",
          policy: { secretPatterns: [] },
          signal: controller.signal,
        },
        resources,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "io", secondaryCancellation: { cause: reason } },
      });
      if (result.ok) throw new Error("Policy failure was ignored");
      expect(result.error.message).toContain("policy read failed");
      expect(resources.cleanupResources).toEqual(
        closeFails ? [policyPath] : [],
      );
    } finally {
      allowClose = true;
      await resources.close();
    }
  },
);

it("preserves physical Git failure and exact cancellation across parallel traversal", async () => {
  const root = await createTestTempDirectory("rea-reference-parallel-abort-");
  const gitdir = join(root, ".git");
  await mkdir(gitdir);
  const head = join(gitdir, "HEAD");
  await writeFile(head, "ref: refs/heads/main\n");
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = { caller: "cancel while Git metadata fails" };
  const physical = Object.assign(new Error("HEAD read EIO"), { code: "EIO" });
  let entered!: () => void;
  let release!: () => void;
  const opendirEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  opendirMock.mockImplementation(async (...args) => {
    entered();
    await gate;
    return actual.opendir(...args);
  });
  openMock.mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (resolve(String(args[0])) === resolve(head))
      vi.spyOn(handle, "read").mockImplementation(async () => {
        await opendirEntered;
        controller.abort(reason);
        release();
        throw physical;
      });
    return handle;
  });
  try {
    const result = await importReferenceSource(
      {
        root,
        caller: "test",
        policy: { secretPatterns: [] },
        signal: controller.signal,
      },
      resources,
    );
    if (result.ok) throw new Error("Expected failure");
    expect(result.error.code).toBe("io");
    expect(result.error.secondaryCancellation?.cause).toBe(reason);
    expect(((result.error.cause as Error).cause as Error).cause).toBe(physical);
  } finally {
    release();
    await resources.close();
  }
});

it.each(["metadata", "import"] as const)(
  "preserves optional commondir absence when its probe coincides with cancellation (%s)",
  async (surface) => {
    const root = await createTestTempDirectory("rea-reference-optional-git-");
    const gitdir = join(root, ".git");
    await mkdir(gitdir);
    await writeFile(
      join(gitdir, "HEAD"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );
    const commondir = join(gitdir, "commondir");
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = { caller: "stop after optional metadata absence" };
    let probed = false;
    openMock.mockImplementation(async (...args) => {
      try {
        return await actual.open(...args);
      } catch (cause: unknown) {
        if (resolve(String(args[0])) === resolve(commondir)) {
          probed = true;
          controller.abort(reason);
        }
        throw cause;
      }
    });
    try {
      const result =
        surface === "metadata"
          ? await readReferenceSourceVcs(root, resources, controller.signal)
          : await importReferenceSource(
              {
                root,
                caller: "test",
                policy: { secretPatterns: [] },
                signal: controller.signal,
              },
              resources,
            );
      expect(probed).toBe(true);
      expect(controller.signal.reason).toBe(reason);
      if (surface === "metadata")
        expect(result).toEqual({
          ok: true,
          value: { kind: "unknown", head: null, dirty: null },
        });
      else {
        if (result.ok) throw new Error("Expected cancelled import");
        expect(result.error.code).toBe("cancelled");
        expect(result.error.cause).toBe(reason);
      }
    } finally {
      await resources.close();
    }
  },
);

it.each([
  ["lstat", false],
  ["lstat", true],
  ["stat", false],
  ["stat", true],
  ["realpath", false],
  ["realpath", true],
] as const)(
  "retains physical git directory %s with late abort (same reason: %s)",
  async (stage, sameReason) => {
    const root = await createTestTempDirectory("rea-git-physical-");
    await mkdir(join(root, ".git"));
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const physical = Object.assign(new Error("git lookup failed"), {
      code: "EIO",
    });
    const reason = sameReason ? physical : { caller: "stopped" };
    const reject = (): never => {
      controller.abort(reason);
      throw physical;
    };
    if (stage === "lstat")
      lstatMock.mockImplementation(async (...args) => {
        if (resolve(String(args[0])) === resolve(root, ".git")) return reject();
        return actual.lstat(...args);
      });
    else if (stage === "stat")
      statMock.mockImplementation(async (...args) => {
        if (resolve(String(args[0])) === resolve(root, ".git")) return reject();
        return actual.stat(...args);
      });
    else
      realpathMock.mockImplementation(async (...args) => {
        if (resolve(String(args[0])) === resolve(root, ".git")) return reject();
        return actual.realpath(...args);
      });
    try {
      const result = await importReferenceSource(
        {
          root,
          caller: "test",
          policy: { secretPatterns: [] },
          signal: controller.signal,
        },
        resources,
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "io",
          cause: physical,
          secondaryCancellation: { cause: reason },
        },
      });
    } finally {
      await resources.close();
    }
  },
);

it("preserves real cancellation between Git directory lookup checkpoints", async () => {
  const root = await createTestTempDirectory("rea-git-checkpoint-");
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = { caller: "stopped" };
  lstatMock.mockImplementation(async (...args) => {
    if (resolve(String(args[0])) === resolve(root, ".git")) {
      controller.abort(reason);
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    }
    return actual.lstat(...args);
  });
  try {
    const result = await importReferenceSource(
      {
        root,
        caller: "test",
        policy: { secretPatterns: [] },
        signal: controller.signal,
      },
      resources,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "cancelled", cause: reason },
    });
  } finally {
    await resources.close();
  }
});

it("retains physical Git discovery lstat failure with late abort through VCS", async () => {
  const root = await createTestTempDirectory("rea-git-vcs-physical-");
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const physical = Object.assign(new Error("git discovery failed"), {
    code: "EIO",
  });
  lstatMock.mockImplementation(async (...args) => {
    if (resolve(String(args[0])) === resolve(root, ".git")) {
      controller.abort(physical);
      throw physical;
    }
    return actual.lstat(...args);
  });
  try {
    const result = await readReferenceSourceVcs(
      root,
      resources,
      controller.signal,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "io", secondaryCancellation: { cause: physical } },
    });
  } finally {
    await resources.close();
  }
});
