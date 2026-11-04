import { describe, expect, it, vi } from "vitest";

import {
  ghidraJavaHomeSaveDenial,
  probeGhidraTemporaryDirectory,
  type GhidraTemporaryDirectoryHost,
} from "./GhidraTemporaryDirectory.js";

const denied = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted`), { code });

const host = (
  overrides: Partial<GhidraTemporaryDirectoryHost> = {},
): GhidraTemporaryDirectoryHost => ({
  tmpdir: () => "C:\\sandbox\\tmp",
  writeProbe: () => Promise.resolve(),
  removeProbe: () => Promise.resolve(),
  ...overrides,
});

describe("Ghidra temporary directory probe", () => {
  it("reports success only after the probe file is written and removed", async () => {
    const removeProbe = vi.fn(() => Promise.resolve());
    await expect(
      probeGhidraTemporaryDirectory(host({ removeProbe })),
    ).resolves.toEqual({ ok: true, directory: "C:\\sandbox\\tmp" });
    expect(removeProbe).toHaveBeenCalledTimes(1);
  });

  it("fails closed with the system code when the write is denied", async () => {
    const removeProbe = vi.fn(() => Promise.reject(denied("ENOENT")));
    const result = await probeGhidraTemporaryDirectory(
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

  it("retains the probe path when a failed write cannot be cleaned up", async () => {
    const result = await probeGhidraTemporaryDirectory(
      host({
        writeProbe: () => Promise.reject(denied("EIO")),
        removeProbe: () => Promise.reject(denied("EPERM")),
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      stage: "write",
      retainedPath: expect.stringContaining("rea-doctor-probe-"),
    });
  });

  it("fails closed when the written probe cannot be deleted", async () => {
    const result = await probeGhidraTemporaryDirectory(
      host({ removeProbe: () => Promise.reject(denied("EPERM")) }),
    );
    expect(result).toMatchObject({
      ok: false,
      stage: "cleanup",
      code: "EPERM",
      retainedPath: expect.stringContaining("rea-doctor-probe-"),
    });
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
