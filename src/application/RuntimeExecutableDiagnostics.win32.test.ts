import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeVersionForTesting as executeVersion,
  windowsBatchCommandForTesting as windowsBatchCommand,
} from "./RuntimeExecutableDiagnostics.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("windowsBatchCommand", () => {
  it("returns null off Windows even for batch files", () => {
    expect(windowsBatchCommand("C:\\tools\\npm.cmd", "linux")).toBeNull();
    expect(windowsBatchCommand("C:\\tools\\npm.cmd", "darwin")).toBeNull();
  });

  it("returns null for non-batch candidates on win32", () => {
    expect(windowsBatchCommand("C:\\tools\\node.exe", "win32")).toBeNull();
    expect(windowsBatchCommand("/usr/local/bin/npm", "win32")).toBeNull();
  });

  it.each(["npm.cmd", "npm.CMD", "tool.bat", "tool.BAT"])(
    "routes %s through cmd.exe on win32",
    (file) => {
      expect(windowsBatchCommand(`C:\\tools\\${file}`, "win32")).toEqual({
        executable: "C:\\Windows\\System32\\cmd.exe",
        arguments: ["/d", "/s", "/c", `"C:\\tools\\${file}" --version`],
      });
    },
  );

  it("preserves paths with spaces in a single /c argument", () => {
    const command = windowsBatchCommand(
      "C:\\Program Files\\nodejs\\npm.cmd",
      "win32",
    );
    expect(command?.arguments[3]).toBe(
      '"C:\\Program Files\\nodejs\\npm.cmd" --version',
    );
  });

  it("doubles embedded quotes so they cannot break out of the /c string", () => {
    const command = windowsBatchCommand('C:\\tools\\evil".cmd', "win32");
    expect(command?.arguments[3]).toBe('"C:\\tools\\evil"".cmd" --version');
  });

  it("honours an explicit SystemRoot", () => {
    const command = windowsBatchCommand(
      "C:\\tools\\npm.cmd",
      "win32",
      "D:\\Win",
    );
    expect(command?.executable).toBe("D:\\Win\\System32\\cmd.exe");
  });
});

describe.runIf(process.platform === "win32")("executeVersion on win32", () => {
  it("probes a real .bat shim without spawn EINVAL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rea-win32-"));
    roots.push(dir);
    const shim = join(dir, "probe.bat");
    await writeFile(shim, "@echo 9.9.9\r\n");
    const result = await executeVersion(
      shim,
      10_000,
      process.env.PATH ?? "",
      "win32",
    );
    expect(result).toMatchObject({ ok: true, version: "9.9.9" });
  });
});
