import { win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { err, ok } from "../../src/domain/result.js";
import { RIZIN_PROVIDER_IDENTITY } from "../../src/rizin/RizinProviderIdentity.js";
import { resolveWindowsProviderExecutable } from "../../src/process/WindowsProviderExecutable.js";
import { createReverseEngineeringCommandPort } from "../../src/composition/reverseEngineering.js";

const windowsLookup = (cwd: string, files: readonly string[]) => {
  const existingFiles = new Set(
    files.map((path) => win32.normalize(path).toLowerCase()),
  );
  return {
    cwd,
    isFile: (path: string): boolean =>
      existingFiles.has(win32.normalize(path).toLowerCase()),
  };
};

describe("resolveWindowsProviderExecutable", () => {
  it("resolves a bare name from quoted and relative Windows PATH entries", () => {
    const cwd = "C:\\work";
    const expected = "C:\\work\\Program Files\\REA Tools\\objdump.EXE";
    expect(
      resolveWindowsProviderExecutable(
        "objdump",
        {
          PATH: `.;".\\Program Files\\REA Tools";D:\\unused`,
          PATHEXT: ".COM;.EXE;.BAT",
        },
        windowsLookup(cwd, [expected]),
      ),
    ).toEqual(ok(expected));
  });

  it("resolves a relative configured path against the caller's Windows CWD", () => {
    expect(
      resolveWindowsProviderExecutable(
        ".\\tools\\objdump.exe",
        {},
        windowsLookup("D:\\analysis", []),
      ),
    ).toEqual(ok("D:\\analysis\\tools\\objdump.exe"));
  });

  it("resolves relative PATH hits to absolute drive paths", () => {
    const expected = "D:\\analysis\\bin\\rizin.EXE";
    expect(
      resolveWindowsProviderExecutable(
        "rizin",
        { PATH: ".\\bin", PATHEXT: ".EXE" },
        windowsLookup("D:\\analysis", [expected]),
      ),
    ).toEqual(ok(expected));
  });

  it("skips script extensions and preserves a caller-selected absolute path", () => {
    const expected = "C:\\tools\\rizin.EXE";
    const selected = "C:\\tools\\rizin.exe";
    expect(
      resolveWindowsProviderExecutable(
        "rizin",
        { PATH: "C:\\tools", PATHEXT: ".CMD;.BAT;.EXE;.COM" },
        windowsLookup("C:\\work", ["C:\\tools\\rizin.CMD", expected]),
      ),
    ).toEqual(ok(expected));
    expect(
      resolveWindowsProviderExecutable(
        selected,
        {},
        windowsLookup("D:\\work", []),
      ),
    ).toEqual(ok(selected));
  });

  it("refuses an unresolved bare name instead of letting Windows search the current directory", () => {
    expect(
      resolveWindowsProviderExecutable(
        "missing-tool",
        { PATH: ".\\tools", PATHEXT: ".EXE" },
        windowsLookup("C:\\work", []),
      ),
    ).toEqual(err({ kind: "not_found" }));
    expect(
      resolveWindowsProviderExecutable(
        "missing-tool",
        { PATH: "C:\\tools", PATHEXT: ".EXE;C:\\bad" },
        windowsLookup("C:\\work", []),
      ),
    ).toEqual(err({ kind: "invalid_extension", extension: "C:\\bad" }));
  });

  it("passes an absolute selected command through provider composition", () => {
    const commands = createReverseEngineeringCommandPort(
      { REA_OBJDUMP_COMMAND: "C:\\tools\\objdump.exe" },
      "win32",
    );
    expect(
      commands.objdump({ path: "artifact", operation: "file_headers" }),
    ).toMatchObject({
      ok: true,
      value: { executable: "C:\\tools\\objdump.exe" },
    });
  });

  it("reports a bare command missing from PATH as unavailable before launch", () => {
    const commands = createReverseEngineeringCommandPort(
      { PATH: "", REA_RIZIN_COMMAND: "rea-missing-rizin" },
      "win32",
    );
    expect(commands.rizin({ path: "artifact", command: "i" })).toMatchObject({
      ok: false,
      error: {
        identity: { id: RIZIN_PROVIDER_IDENTITY.id },
        command: "rea-missing-rizin",
        reason: { kind: "not_found" },
      },
    });
  });
});
