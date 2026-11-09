import { describe, expect, it, vi } from "vitest";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

const nativeCall = vi.hoisted(() => vi.fn());

vi.mock("./WindowsNativeLoader.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./WindowsNativeLoader.js")>();
  return {
    ...actual,
    requireWindowsNativeAuthority: () => ({ call: nativeCall }),
  };
});

import {
  WindowsPrivateRuntime,
  WindowsSnapshotCancelledError,
  windowsPrivateRuntime,
} from "./WindowsPrivateRuntime.js";

const observation = {
  requestedPath: "C:\\rea-private",
  finalPath: "C:\\rea-private",
  filesystem: "NTFS",
  volumeSerial: "0123456789abcdef",
  fileId: "0123456789abcdef0123456789abcdef",
  size: 0,
  directory: true,
  path: "C:\\rea-private",
  handle: {},
  privateDacl: true,
};

const nativeFailure = (win32Code: number): Error =>
  Object.assign(new Error(`native close failed (${win32Code})`), {
    code: "ERR_REA_WINDOWS_NATIVE",
    win32Code,
  });

describe("Windows private runtime cleanup retry", () => {
  it("retries a transient sharing conflict through the same owned close", async () => {
    const conflict = nativeFailure(32);
    let closes = 0;
    nativeCall.mockImplementation((operation: string) => {
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_close" && closes++ === 0) throw conflict;
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");

    await runtime.close();

    expect(closes).toBe(2);
    expect(() => windowsPrivateRuntime(observation.path)).toThrow(
      /No native private runtime/u,
    );
  });

  it.each([
    ["a native access denial", nativeFailure(5)],
    [
      "a POSIX-style access denial",
      Object.assign(new Error("access denied"), {
        code: "EACCES",
        win32Code: 32,
      }),
    ],
    [
      "a native error with string code 32",
      Object.assign(new Error("sharing conflict"), {
        code: "ERR_REA_WINDOWS_NATIVE",
        win32Code: "32",
      }),
    ],
    [
      "a native error without a Win32 code",
      Object.assign(new Error("native failure"), {
        code: "ERR_REA_WINDOWS_NATIVE",
      }),
    ],
    [
      "a missing-path error carrying a Win32 sharing code",
      Object.assign(new Error("path disappeared"), {
        code: "ENOENT",
        win32Code: 32,
      }),
    ],
    [
      "a nested cleanup detail carrying a Win32 sharing code",
      Object.assign(new Error("native failure"), {
        code: "ERR_REA_WINDOWS_NATIVE",
        cleanup: { win32Code: 32 },
      }),
    ],
  ] as const)(
    "does not retry %s and retains the owner for a later close",
    async (_label, denied) => {
      let closes = 0;
      nativeCall.mockImplementation((operation: string) => {
        if (operation === "runtime_create") return observation;
        if (operation === "runtime_close" && closes++ === 0) throw denied;
        return null;
      });
      const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");

      await expect(runtime.close()).rejects.toBe(denied);
      expect(closes).toBe(1);
      expect(windowsPrivateRuntime(observation.path)).toBe(runtime);
      await runtime.close();
      expect(closes).toBe(2);
    },
  );

  it("shares one in-flight close across concurrent callers", async () => {
    let closes = 0;
    nativeCall.mockImplementation((operation: string) => {
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_close" && closes++ === 0)
        throw nativeFailure(33);
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
    const first = runtime.close();
    const second = runtime.close();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(closes).toBe(2);
  });

  it("retains the exact final native error and owner when conflicts persist", async () => {
    const conflict = nativeFailure(32);
    let closes = 0;
    nativeCall.mockImplementation((operation: string) => {
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_close") {
        closes++;
        throw conflict;
      }
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");

    await expect(runtime.close()).rejects.toBe(conflict);

    expect(closes).toBe(10);
    expect(windowsPrivateRuntime(observation.path)).toBe(runtime);
    nativeCall.mockImplementation((operation: string) =>
      operation === "runtime_create" ? observation : null,
    );
    await runtime.close();
  });
});

const admittedFile = {
  requestedPath: "C:\\rea-private\\endpoint",
  finalPath: "C:\\rea-private\\endpoint",
  filesystem: "NTFS" as const,
  volumeSerial: "0123456789abcdef",
  fileId: "fedcba9876543210fedcba9876543210",
  size: 2,
  directory: false,
  handle: { kind: "admitted-file" },
};

describe("Windows private runtime transient write", () => {
  it("writes through runtime_write_transient and never retains via runtime_write", async () => {
    const operations: string[] = [];
    nativeCall.mockImplementation((operation: string) => {
      operations.push(operation);
      if (operation === "runtime_create") return observation;
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");

    runtime.writeTransientFile("job.source", "source-bytes");

    expect(operations).toEqual(["runtime_create", "runtime_write_transient"]);
    expect(nativeCall).toHaveBeenCalledWith("runtime_write_transient", [
      observation.handle,
      "job.source",
      Buffer.from("source-bytes"),
    ]);
    expect(operations).not.toContain("runtime_write");
    await runtime.close();
  });

  it("keeps immutable runtime_write distinct from transient staging", async () => {
    const operations: string[] = [];
    nativeCall.mockImplementation((operation: string) => {
      operations.push(operation);
      if (operation === "runtime_create") return observation;
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");

    runtime.writeFile("descriptor.json", "fixture");
    runtime.writeTransientFile("job.source", "source-bytes");

    expect(operations).toEqual([
      "runtime_create",
      "runtime_write",
      "runtime_write_transient",
    ]);
    await runtime.close();
  });
});

describe("Windows private runtime admitted file close", () => {
  it("retries the same file wrapper before the runtime tree walk", async () => {
    const failure = nativeFailure(5);
    const operations: string[] = [];
    let fileCloses = 0;
    nativeCall.mockImplementation((operation: string) => {
      operations.push(operation);
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_open") return admittedFile;
      if (operation === "read") return Buffer.from("ok");
      if (operation === "close" && fileCloses++ === 0) throw failure;
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
    const readFailure: unknown = (() => {
      try {
        runtime.readFile("endpoint", 64);
        return undefined;
      } catch (cause: unknown) {
        return cause;
      }
    })();
    expect(readFailure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(readFailure instanceof ArtifactReaderFailure))
      throw new Error("expected cleanup");
    expect(readFailure.cleanup?.resources).toEqual([
      admittedFile.requestedPath,
    ]);
    expect(readFailure.partialObservation).toBeUndefined();
    const cleanup = new ProviderCleanupError(
      "ghidra",
      readFailure.cleanup?.resources ?? [],
      {},
      { cause: readFailure },
    );
    bindArtifactFileCleanup(readFailure, cleanup);
    expect(cleanup.cleanupIncomplete).toBe(true);
    await runtime.close();
    expect(cleanup.cleanupIncomplete).toBe(false);

    expect(fileCloses).toBe(2);
    expect(operations).toEqual([
      "runtime_create",
      "runtime_open",
      "read",
      "close",
      "close",
      "runtime_close",
    ]);
  });

  it("does not walk the runtime while the admitted file close is still failing", async () => {
    const denied = nativeFailure(5);
    const operations: string[] = [];
    nativeCall.mockImplementation((operation: string) => {
      operations.push(operation);
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_open") return admittedFile;
      if (operation === "read") return Buffer.from("ok");
      if (operation === "close") throw denied;
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
    const readFailure: unknown = (() => {
      try {
        runtime.readFile("endpoint", 64);
        return undefined;
      } catch (cause: unknown) {
        return cause;
      }
    })();
    expect(readFailure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(readFailure instanceof ArtifactReaderFailure))
      throw new Error("expected cleanup");
    expect(readFailure.cleanup?.resources).toEqual([
      admittedFile.requestedPath,
    ]);

    await expect(runtime.close()).rejects.toBe(denied);

    expect(operations).toEqual([
      "runtime_create",
      "runtime_open",
      "read",
      "close",
      "close",
    ]);
    expect(windowsPrivateRuntime(observation.path)).toBe(runtime);
    nativeCall.mockImplementation((operation: string) => {
      operations.push(operation);
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_open") return admittedFile;
      if (operation === "read") return Buffer.from("ok");
      return null;
    });
    await runtime.close();
    expect(operations.slice(-2)).toEqual(["close", "runtime_close"]);
    expect(() => windowsPrivateRuntime(observation.path)).toThrow(
      /No native private runtime/u,
    );
  });
});

it.each([995, 5])(
  "classifies native snapshot code %i independently of a late abort",
  async (code) => {
    const controller = new AbortController();
    const failure = nativeFailure(code);
    nativeCall.mockImplementation((operation: string) => {
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_snapshot") return Promise.reject(failure);
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
    const pending = runtime.snapshot(
      "C:\\target.bin",
      "target.bin",
      controller.signal,
    );
    controller.abort(null);
    const result: unknown = await pending.catch((cause: unknown) => cause);
    if (code === 995) {
      expect(result).toBeInstanceOf(WindowsSnapshotCancelledError);
      expect(result).toMatchObject({ reason: null, cause: failure });
    } else expect(result).toBe(failure);
    await runtime.close();
  },
);

it("refuses an oversized admitted runtime file before reading and still closes its handle", async () => {
  const operations: string[] = [];
  nativeCall.mockImplementation((operation: string) => {
    operations.push(operation);
    if (operation === "runtime_create") return observation;
    if (operation === "runtime_open") return { ...admittedFile, size: 1024 };
    if (operation === "read") return Buffer.from("x".repeat(1024));
    return null;
  });
  const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
  try {
    expect(() => runtime.readFile("endpoint", 64)).toThrow();
    expect(operations).toEqual(["runtime_create", "runtime_open", "close"]);
  } finally {
    await runtime.close();
  }
});

it("retains bound refusal and failed file close until the same owner recovers", async () => {
  const failure = nativeFailure(5);
  const operations: string[] = [];
  let closes = 0;
  nativeCall.mockImplementation((operation: string) => {
    operations.push(operation);
    if (operation === "runtime_create") return observation;
    if (operation === "runtime_open") return { ...admittedFile, size: 65 };
    if (operation === "close" && closes++ === 0) throw failure;
    return null;
  });
  const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
  let reported: unknown;
  try {
    runtime.readFile("endpoint", 64);
  } catch (cause: unknown) {
    reported = cause;
  }
  expect(reported).toBeInstanceOf(ArtifactReaderFailure);
  if (!(reported instanceof ArtifactReaderFailure))
    throw new Error("expected retained cleanup");
  expect(reported.reason).toBe("limit");
  expect(reported.cleanup?.resources).toEqual([admittedFile.requestedPath]);
  const cleanup = new ProviderCleanupError(
    "ghidra",
    reported.cleanup?.resources ?? [],
    {},
    { cause: reported },
  );
  bindArtifactFileCleanup(reported, cleanup);
  expect(cleanup.cleanupIncomplete).toBe(true);
  expect(operations).toEqual(["runtime_create", "runtime_open", "close"]);
  await runtime.close();
  expect(cleanup.cleanupIncomplete).toBe(false);
  expect(closes).toBe(2);
});

it.each(["valid", "oversized"] as const)(
  "observes a %s Windows Ghidra endpoint through its owning runtime",
  async (kind) => {
    const { observeGhidraEndpoint } =
      await import("../ghidra/GhidraTransport.js");
    const valid = Buffer.from('{"host":"127.0.0.1","port":65535}\n');
    const operations: string[] = [];
    nativeCall.mockImplementation((operation: string) => {
      operations.push(operation);
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_open")
        return {
          ...admittedFile,
          size: kind === "valid" ? valid.length : valid.length + 1,
        };
      if (operation === "read") return valid;
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    )!;
    Object.defineProperty(process, "platform", {
      ...originalPlatform,
      value: "win32",
    });
    try {
      const result = await observeGhidraEndpoint({
        transport: "authenticated-loopback-tcp",
        path: admittedFile.requestedPath,
      });
      if (kind === "valid")
        expect(result).toEqual({
          ok: true,
          value: { host: "127.0.0.1", port: 65535 },
        });
      else {
        expect(result).toMatchObject({
          ok: false,
          error: {
            kind: "start",
            message: "Ghidra TCP endpoint is invalid",
            cause: { reason: "limit" },
          },
        });
        expect(operations).not.toContain("read");
      }
      expect(operations).toContain("close");
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      await runtime.close();
    }
  },
);

it("seals runtime admission as cleanup begins", async () => {
  const operations: string[] = [];
  nativeCall.mockImplementation((operation: string) => {
    operations.push(operation);
    if (operation === "runtime_create") return observation;
    if (operation === "runtime_open") return admittedFile;
    return null;
  });
  const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
  const closing = runtime.close();
  expect(() => runtime.writeFile("after-close.txt", "forbidden")).toThrow();
  expect(() => runtime.readFile("endpoint", 64)).toThrow();
  await expect(runtime.snapshot("C:\\input", "snapshot")).rejects.toThrow();
  expect(operations).not.toContain("runtime_open");
  expect(operations).not.toContain("runtime_write");
  expect(operations).not.toContain("runtime_snapshot");
  await closing;
});

it("keeps runtime cleanup retryable and admission sealed after a file owner releases", async () => {
  const fileFailure = nativeFailure(5);
  const runtimeFailure = nativeFailure(5);
  let fileCloses = 0;
  let rootCloses = 0;
  nativeCall.mockImplementation((operation: string) => {
    if (operation === "runtime_create") return observation;
    if (operation === "runtime_open") return admittedFile;
    if (operation === "read") return Buffer.from("ok");
    if (operation === "close" && fileCloses++ === 0) throw fileFailure;
    if (operation === "runtime_close" && rootCloses++ === 0)
      throw runtimeFailure;
    return null;
  });
  const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
  let reported: unknown;
  try {
    runtime.readFile("endpoint", 64);
  } catch (cause: unknown) {
    reported = cause;
  }
  if (!(reported instanceof ArtifactReaderFailure))
    throw new Error("expected cleanup");
  const cleanup = new ProviderCleanupError(
    "ghidra",
    reported.cleanup?.resources ?? [],
    {},
    { cause: reported },
  );
  bindArtifactFileCleanup(reported, cleanup);
  await expect(runtime.close()).rejects.toBe(runtimeFailure);
  expect(cleanup.cleanupIncomplete).toBe(false);
  expect(windowsPrivateRuntime(observation.path)).toBe(runtime);
  expect(() => runtime.readFile("endpoint", 64)).toThrow();
  await runtime.close();
  expect(fileCloses).toBe(2);
  expect(rootCloses).toBe(2);
  expect(() => windowsPrivateRuntime(observation.path)).toThrow();
});
