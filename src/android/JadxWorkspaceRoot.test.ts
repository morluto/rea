import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";

const { spawnMock, tmpdirMock, lstatMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  tmpdirMock: vi.fn(),
  lstatMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  tmpdir: tmpdirMock,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  lstat: lstatMock,
}));

import { createJadxWorkspaceRoot } from "./JadxWorkspaceRoot.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const mockGuardian = () => {
  const parent = "C:\\Users\\研究者\\AppData\\Local\\Temp";
  const path = win32.join(parent, `rea-android-${"a".repeat(32)}`);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: vi.fn(),
  });
  child.stdin.once("finish", () => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  tmpdirMock.mockReturnValue(parent);
  const missingPath = Object.assign(new Error("missing after cleanup"), {
    code: "ENOENT",
  });
  lstatMock.mockRejectedValue(missingPath);
  spawnMock.mockReturnValue(child);
  const ready = JSON.stringify({
    path,
    volumeSerial: "0123456789abcdef",
    fileId: "0123456789abcdef0123456789abcdef",
    privateDacl: true,
  });
  return { child, path, ready };
};

it("decodes a Windows guardian path across split UTF-8 stdout writes", async () => {
  const { child, path, ready: line } = mockGuardian();
  const ready = Buffer.from(line + "\n");
  const split = ready.indexOf(Buffer.from("研")) + 1;

  const start = createJadxWorkspaceRoot("win32");
  setImmediate(() => {
    child.stdout.write(ready.subarray(0, split), () => {
      setImmediate(() => child.stdout.write(ready.subarray(split)));
    });
  });

  const root = await start;
  try {
    expect(root.path).toBe(path);
  } finally {
    await expect(root.close()).resolves.toBeUndefined();
  }
  expect(lstatMock).toHaveBeenCalledWith(path);
});

it("limits only the first guardian frame and releases its stdout reader after readiness", async () => {
  const { child, path, ready } = mockGuardian();
  const startup = createJadxWorkspaceRoot("win32");
  const frame = ready + " ".repeat(4095 - Buffer.byteLength(ready)) + "\n";
  child.stdout.write(frame + "diagnostics after readiness".repeat(200));

  const root = await startup;
  try {
    expect(root.path).toBe(path);
    expect(child.stdout.destroyed).toBe(false);
    expect(child.stdout.listenerCount("data")).toBe(0);
    child.stdout.emit("error", new Error("late guardian pipe error"));
    expect(root.failureSignal?.aborted).toBe(false);
  } finally {
    await root.close();
  }
  expect(lstatMock).toHaveBeenCalledWith(path);
});

it.each([
  {
    reason: "a frame above the byte limit",
    kind: "limit",
    bytes: Buffer.from("测".repeat(1_400) + "\n"),
    message: "Android workspace guardian readiness exceeded 4 KiB",
  },
  {
    reason: "invalid UTF-8",
    kind: "malformed",
    bytes: Buffer.from([0xff, 0x0a]),
    message: "Android workspace guardian readiness is not valid UTF-8",
  },
  {
    reason: "an unfinished frame",
    kind: "truncated",
    bytes: Buffer.from("{}"),
    message: "Android workspace guardian stdout ended before readiness",
  },
])("cleans up after $reason", async ({ bytes, kind, message }) => {
  const { child } = mockGuardian();
  const startup = createJadxWorkspaceRoot("win32");
  child.stdout.end(bytes);

  await expect(startup).rejects.toMatchObject({ kind, message });
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.unref).toHaveBeenCalledOnce();
});

it("retains the original pipe error during startup", async () => {
  const { child } = mockGuardian();
  const startup = createJadxWorkspaceRoot("win32");
  const failure = new Error("guardian startup pipe error");
  child.stdout.destroy(failure);

  await expect(startup).rejects.toBe(failure);
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.unref).toHaveBeenCalledOnce();
});
