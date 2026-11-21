import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tmpdir } from "node:os";
import { dirname, parse, resolve, sep } from "node:path";
import * as fs from "node:fs/promises";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import { createInspectionResources } from "../../tests/fixtures/inspectionResources.js";
import { probeGhidraTemporaryDirectory } from "./GhidraTemporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});

const denied = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted`), { code });

let resources = createInspectionResources();
let directory: string;
beforeEach(async () => {
  directory = await createTestTempDirectory("rea-ghidra-probe-");
  for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, directory);
});
afterEach(async () => {
  await resources.close().catch(() => undefined);
  resources = createInspectionResources();
  vi.mocked(fs.open).mockReset();
  vi.mocked(fs.unlink).mockReset();
  vi.unstubAllEnvs();
});

describe("Ghidra temporary directory probe", () => {
  it("fails closed with the system code when the write is denied", async () => {
    vi.mocked(fs.open).mockRejectedValueOnce(denied("EPERM"));
    const result = await probeGhidraTemporaryDirectory(resources.owner);
    expect(result).toMatchObject({
      ok: false,
      directory,
      stage: "write",
      code: "EPERM",
    });
    expect(result).not.toHaveProperty("retainedPath");
  });

  it("probes the Ghidra session root rather than an unusable inherited temp", async () => {
    const dotted = resolve(directory, ".cache", "tmp");
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, dotted);
    const { root } = parse(dotted);
    const elements = dotted.slice(root.length).split(sep);
    const firstDotted = elements.findIndex((element) =>
      element.startsWith("."),
    );
    const expected =
      process.platform === "win32"
        ? resolve(root, ...elements.slice(0, firstDotted))
        : resolve("/tmp");
    expect(resolve(tmpdir())).toBe(dotted);
    expect(expected).not.toBe(dotted);
    await expect(
      probeGhidraTemporaryDirectory(resources.owner),
    ).resolves.toEqual({
      ok: true,
      directory: expected,
    });
    expect(dirname(String(vi.mocked(fs.open).mock.calls[0]?.[0]))).toBe(
      expected,
    );
  });

  it.each([
    ["a failed write", "write", true],
    ["a written probe", "cleanup", false],
  ] as const)(
    "retains cleanup ownership of %s whose removal fails and retries it on close",
    async (_label, stage, writeFails) => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      if (writeFails)
        vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
          const file = await actual.open(...args);
          vi.spyOn(file, "writeFile").mockRejectedValueOnce(denied("EIO"));
          return file;
        });
      vi.mocked(fs.unlink)
        .mockRejectedValueOnce(denied("EPERM"))
        .mockRejectedValueOnce(denied("EPERM"));
      const result = await probeGhidraTemporaryDirectory(resources.owner);
      expect(result).toMatchObject({
        ok: false,
        stage,
        retainedPath: expect.stringContaining("rea-doctor-probe-"),
      });
      if (result.ok || result.retainedPath === undefined)
        throw new Error("Expected an owned probe awaiting removal");
      const { retainedPath } = result;
      await expect(fs.access(retainedPath)).resolves.toBeUndefined();
      await expect(resources.close()).rejects.toThrow();
      await expect(fs.access(retainedPath)).resolves.toBeUndefined();
      if (writeFails) await actual.unlink(retainedPath);
      await expect(resources.close()).resolves.toBeUndefined();
      expect(fs.unlink).toHaveBeenCalledTimes(3);
      expect(fs.unlink).toHaveBeenLastCalledWith(retainedPath);
      await expect(fs.access(retainedPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

it.each([
  {
    label: "successful write and close",
    writeFails: false,
    closeFails: false,
    removeFails: false,
  },
  {
    label: "close failure after successful write",
    writeFails: false,
    closeFails: true,
    removeFails: false,
  },
  {
    label: "write and close failures",
    writeFails: true,
    closeFails: true,
    removeFails: false,
  },
  {
    label: "write, close and removal failures",
    writeFails: true,
    closeFails: true,
    removeFails: true,
  },
])(
  "retains the default probe descriptor through $label",
  async ({ writeFails, closeFails, removeFails }) => {
    const { open, unlink } =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const writeFailure = denied("ENOSPC");
    const closeFailure = denied("EIO");
    let descriptor: Awaited<ReturnType<typeof open>> | undefined;
    let closeAttempts = 0;
    let writtenBytes: number | undefined;
    const opening = vi
      .mocked(fs.open)
      .mockImplementationOnce(async (path, flags, mode) => {
        const file = await open(path, flags, mode);
        descriptor = file;
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementation(async () => {
          closeAttempts += 1;
          if (closeFails && closeAttempts === 1) throw closeFailure;
          await close();
        });
        if (writeFails)
          vi.spyOn(file, "writeFile").mockRejectedValueOnce(writeFailure);
        return file;
      });
    if (removeFails)
      vi.mocked(fs.unlink).mockRejectedValueOnce(denied("EPERM"));
    else if (!writeFails && !closeFails)
      vi.mocked(fs.unlink).mockImplementationOnce(async (path) => {
        writtenBytes = (await fs.stat(path)).size;
        await unlink(path);
      });
    try {
      const result = await probeGhidraTemporaryDirectory(resources.owner);
      if (writeFails || closeFails) {
        expect(result).toMatchObject({
          ok: false,
          stage: writeFails ? "write" : "cleanup",
          code: writeFails ? "ENOSPC" : "EIO",
        });
        if (removeFails) expect(result).toHaveProperty("retainedPath");
        else expect(result).not.toHaveProperty("retainedPath");
      } else {
        expect(result).toEqual({ ok: true, directory });
        expect(writtenBytes).toBeGreaterThan(0);
      }
      await resources.close();
      expect(descriptor?.fd).toBe(-1);
      expect(closeAttempts).toBe(closeFails ? 2 : 1);
      expect(fs.unlink).toHaveBeenCalledTimes(removeFails ? 2 : 1);
      const removed = vi.mocked(fs.unlink).mock.calls[0]?.[0];
      if (removed === undefined) throw new Error("Expected a probe removal");
      await expect(fs.access(removed)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      opening.mockRestore();
      if (descriptor !== undefined && descriptor.fd >= 0)
        await descriptor.close();
    }
  },
);
