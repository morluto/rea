import { afterEach, describe, expect, it, vi } from "vitest";

import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { createInspectionResources } from "../../tests/fixtures/inspectionResources.js";
import {
  ghidraJavaHomeSaveDenial,
  probeGhidraTemporaryDirectory,
  type GhidraTemporaryDirectoryHost,
} from "./GhidraTemporaryDirectory.js";
import { ghidraSessionRoot } from "./GhidraSessionRoot.js";

const denied = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted`), { code });

let resources = createInspectionResources();
afterEach(async () => {
  await resources.close().catch(() => undefined);
  resources = createInspectionResources();
});

const host = (
  overrides: Partial<GhidraTemporaryDirectoryHost> = {},
): GhidraTemporaryDirectoryHost => ({
  sessionRoot: () => "C:\\sandbox\\tmp",
  writeProbe: () => Promise.resolve(),
  removeProbe: () => Promise.resolve(),
  ...overrides,
});

describe("Ghidra temporary directory probe", () => {
  it("reports success only after the probe file is written and removed", async () => {
    const removeProbe = vi.fn(() => Promise.resolve());
    await expect(
      probeGhidraTemporaryDirectory(resources.owner, host({ removeProbe })),
    ).resolves.toEqual({ ok: true, directory: "C:\\sandbox\\tmp" });
    expect(removeProbe).toHaveBeenCalledTimes(1);
  });

  it("fails closed with the system code when the write is denied", async () => {
    const removeProbe = vi.fn(() => Promise.reject(denied("ENOENT")));
    const result = await probeGhidraTemporaryDirectory(
      resources.owner,
      host({ writeProbe: () => Promise.reject(denied("EPERM")), removeProbe }),
    );
    expect(result).toMatchObject({
      ok: false,
      directory: "C:\\sandbox\\tmp",
      stage: "write",
      code: "EPERM",
    });
    expect(result).not.toHaveProperty("retainedPath");
  });

  it("probes the Ghidra session root rather than an unusable inherited temp", async () => {
    const writeProbe = vi.fn((_path: string) => Promise.resolve());
    const names = ["TMPDIR", "TMP", "TEMP"] as const;
    const previous = names.map((name) => process.env[name]);
    const dotted = resolve("work", ".cache", "tmp");
    for (const name of names) process.env[name] = dotted;
    let expected: string;
    try {
      expected = ghidraSessionRoot();
      expect(resolve(tmpdir())).toBe(dotted);
      expect(expected).not.toBe(dotted);
      await expect(
        probeGhidraTemporaryDirectory(resources.owner, {
          writeProbe,
          removeProbe: () => Promise.resolve(),
        }),
      ).resolves.toEqual({ ok: true, directory: expected });
    } finally {
      names.forEach((name, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
    expect(dirname(writeProbe.mock.calls[0]?.[0] ?? "")).toBe(expected);
  });

  it.each([
    ["a failed write", "write", () => Promise.reject(denied("EIO"))],
    ["a written probe", "cleanup", () => Promise.resolve()],
  ] as const)(
    "retains cleanup ownership of %s whose removal fails and retries it on close",
    async (_label, stage, writeProbe) => {
      const removeProbe = vi
        .fn<(path: string) => Promise<void>>()
        .mockRejectedValueOnce(denied("EPERM"))
        .mockRejectedValueOnce(denied("EPERM"))
        .mockResolvedValue(undefined);
      const result = await probeGhidraTemporaryDirectory(
        resources.owner,
        host({ writeProbe, removeProbe }),
      );
      expect(result).toMatchObject({
        ok: false,
        stage,
        retainedPath: expect.stringContaining("rea-doctor-probe-"),
      });
      const retainedPath = result.ok ? undefined : result.retainedPath;
      const callsBeforeClose = removeProbe.mock.calls.length;
      await expect(resources.close()).rejects.toThrow();
      await expect(resources.close()).resolves.toBeUndefined();
      expect(removeProbe.mock.calls.slice(callsBeforeClose)).toEqual([
        [retainedPath],
        [retainedPath],
      ]);
    },
  );

  it("does not retain cleanup when the probe was removed", async () => {
    const removeProbe = vi.fn(() => Promise.resolve());
    await probeGhidraTemporaryDirectory(resources.owner, host({ removeProbe }));
    await resources.close();
    expect(removeProbe).toHaveBeenCalledTimes(1);
  });
});

describe("Ghidra java_home.save denial", () => {
  it("extracts the denied path from JVM output", () => {
    expect(
      ghidraJavaHomeSaveDenial([
        "INFO starting\r\njava.io.FileNotFoundException: C:\\Users\\a b\\Temp\\rea-provider-1\\config\\ghidra\\ghidra_12.1.4_PUBLIC\\java_home.save (Access is denied)\r\n\tat java.base/java.io.FileOutputStream.open0(Native Method)",
      ]),
    ).toEqual({
      path: "C:\\Users\\a b\\Temp\\rea-provider-1\\config\\ghidra\\ghidra_12.1.4_PUBLIC\\java_home.save",
    });
  });

  it.each([
    [
      "another denied path",
      "java.io.FileNotFoundException: C:\\x\\other.txt (Access is denied)",
    ],
    [
      "a different failure for the file",
      "java.io.FileNotFoundException: C:\\x\\java_home.save (The system cannot find the path specified)",
    ],
    ["only a mention", "Reading java_home.save failed"],
    ["no output", ""],
  ])("does not classify %s", (_label, text) => {
    expect(ghidraJavaHomeSaveDenial([text])).toBeUndefined();
  });
});
