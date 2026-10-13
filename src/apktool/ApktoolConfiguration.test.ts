import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  APKTOOL_COMMAND_ENV,
  apktoolConfigurationAvailability,
  ApktoolConfigurationFailure,
  apktoolInvocation,
  inspectApktoolClient,
  parseApktoolVersionOutput,
  resolveApktoolCommand,
} from "./ApktoolConfiguration.js";

const lookup = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  stat: lookup.stat,
}));
beforeEach(() => {
  lookup.stat
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
});

describe("resolveApktoolCommand", () => {
  it("prefers an absolute REA_APKTOOL_COMMAND", async () => {
    expect(
      await resolveApktoolCommand(
        {
          [APKTOOL_COMMAND_ENV]: "/usr/local/bin/apktool",
        },
        "linux",
      ),
    ).toEqual({
      command: "/usr/local/bin/apktool",
      commandSource: "environment",
    });
  });

  it("leaves POSIX PATH lookup to process creation", async () => {
    expect(await resolveApktoolCommand({}, "linux")).toEqual({
      command: "apktool",
      commandSource: "path",
    });
  });

  it("rejects a relative environment path explicitly", async () => {
    await expect(
      resolveApktoolCommand({ [APKTOOL_COMMAND_ENV]: "bin/apktool" }),
    ).rejects.toThrow(/must be an absolute path/u);
  });
});

describe("parseApktoolVersionOutput", () => {
  it("reads the version from real apktool output", () => {
    expect(parseApktoolVersionOutput("2.7.0-dirty\n")).toEqual({
      version: "2.7.0-dirty",
    });
  });

  it("reports null when the launcher prints nothing usable", () => {
    expect(parseApktoolVersionOutput(" \n")).toEqual({ version: null });
  });
});

describe("apktoolInvocation", () => {
  const windows = { SystemRoot: "C:\\Windows" };

  it("runs a Windows batch launcher through an explicit cmd.exe call", () => {
    expect(
      apktoolInvocation(
        {
          command: "C:\\ProgramData\\chocolatey\\bin\\apktool.BAT",
          commandSource: "environment",
        },
        ["d", "-o", "C:\\Users\\Analyst\\AppData\\Local\\Temp\\rea out"],
        windows,
        "win32",
      ),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      arguments: [
        "/d",
        "/e:on",
        "/v:off",
        "/s",
        "/c",
        '""C:\\ProgramData\\chocolatey\\bin\\apktool.BAT" "d" "-o" "C:\\Users\\Analyst\\AppData\\Local\\Temp\\rea out""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("runs native executables and POSIX scripts directly", () => {
    for (const [command, platform] of [
      ["C:\\tools\\apktool.exe", "win32"],
      ["/opt/apktool/apktool.cmd", "linux"],
    ] as const)
      expect(
        apktoolInvocation(
          { command, commandSource: "environment" },
          ["--version"],
          windows,
          platform,
        ),
      ).toEqual({
        command,
        arguments: ["--version"],
        windowsVerbatimArguments: false,
      });
  });

  it("reports a batch launcher that cmd.exe would reinterpret before running it", async () => {
    const failure = await inspectApktoolClient(
      {
        command: "C:\\tools & more\\apktool.cmd",
        commandSource: "environment",
      },
      undefined,
      windows,
      "win32",
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApktoolConfigurationFailure);
    if (!(failure instanceof ApktoolConfigurationFailure)) return;
    expect(failure.code).toBe("launcher_unsupported");
    expect(apktoolConfigurationAvailability(failure)).toMatchObject({
      status: "unavailable",
      code: "not_configured",
      diagnostics: {
        selected_command: "C:\\tools & more\\apktool.cmd",
        remediation: expect.stringContaining(APKTOOL_COMMAND_ENV),
      },
    });
  });
});

describe("Windows PATH launcher selection", () => {
  const environment = {
    Path: '"C:\\Selected Tools";C:\\Other Tools',
    PathExt: ".EXE;.CMD;.BAT",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    NoDefaultCurrentDirectoryInExePath: "",
  };
  const files = (...paths: string[]) => {
    const selected = new Set(paths.map((path) => path.toLowerCase()));
    lookup.stat.mockImplementation(async (path: string) => {
      if (selected.has(path.toLowerCase())) return { isFile: () => true };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
  };

  it.each([".BAT", ".CMD"])(
    "resolves a default %s launcher before choosing cmd.exe for version and decode",
    async (extension) => {
      const command = `C:\\Selected Tools\\apktool${extension}`;
      files(command);
      const selection = await resolveApktoolCommand(environment, "win32");
      expect(selection).toEqual({ command, commandSource: "path" });
      for (const arguments_ of [
        ["--version"],
        ["d", "-o", "C:\\output folder", "C:\\target.apk"],
      ]) {
        const invocation = apktoolInvocation(
          selection,
          arguments_,
          environment,
          "win32",
        );
        expect(invocation).toEqual({
          command: environment.ComSpec,
          arguments: [
            "/d",
            "/e:on",
            "/v:off",
            "/s",
            "/c",
            `"${[command, ...arguments_].map((token) => `"${token}"`).join(" ")}"`,
          ],
          windowsVerbatimArguments: true,
        });
      }
    },
  );

  it("honors PATH directory order before extension order", async () => {
    files("C:\\Selected Tools\\apktool.CMD", "C:\\Other Tools\\apktool.EXE");
    expect(await resolveApktoolCommand(environment, "win32")).toMatchObject({
      command: "C:\\Selected Tools\\apktool.CMD",
    });
  });

  it("honors the selected PATHEXT ordering", async () => {
    files("C:\\Selected Tools\\apktool.CMD", "C:\\Selected Tools\\apktool.EXE");
    expect(
      await resolveApktoolCommand(
        { ...environment, PathExt: ".CMD;.EXE" },
        "win32",
      ),
    ).toMatchObject({ command: "C:\\Selected Tools\\apktool.CMD" });
  });

  it("keeps native executable arguments outside cmd.exe interpretation", async () => {
    const command = "C:\\Selected Tools\\apktool.EXE";
    files(command);
    const selection = await resolveApktoolCommand(environment, "win32");
    const arguments_ = ["d", "C:\\input & literal.apk"];
    expect(
      apktoolInvocation(selection, arguments_, environment, "win32"),
    ).toEqual({
      command,
      arguments: arguments_,
      windowsVerbatimArguments: false,
    });
  });

  it("preserves explicit launcher spelling without searching PATH", async () => {
    const command = "C:\\selected alias\\APKTOOL.cmd";
    expect(
      await resolveApktoolCommand(
        { ...environment, [APKTOOL_COMMAND_ENV]: command },
        "win32",
      ),
    ).toEqual({ command, commandSource: "environment" });
    expect(lookup.stat).not.toHaveBeenCalled();
  });

  it("does not inspect the current directory when the caller disables it", async () => {
    await expect(
      resolveApktoolCommand(environment, "win32"),
    ).rejects.toMatchObject({ code: "command_missing" });
    expect(
      lookup.stat.mock.calls.every(
        ([path]) =>
          String(path).startsWith("C:\\Selected Tools\\") ||
          String(path).startsWith("C:\\Other Tools\\"),
      ),
    ).toBe(true);
  });

  it("does not turn an explicitly empty PATHEXT into default extensions", async () => {
    files("C:\\Selected Tools\\apktool.EXE");
    await expect(
      resolveApktoolCommand({ ...environment, PathExt: "" }, "win32"),
    ).rejects.toMatchObject({ code: "command_missing" });
    expect(lookup.stat).not.toHaveBeenCalled();
  });

  it("skips directories without treating them as executable launchers", async () => {
    files("C:\\Other Tools\\apktool.EXE");
    const stat = lookup.stat.getMockImplementation()!;
    lookup.stat.mockImplementation(async (path: string) =>
      path === "C:\\Selected Tools\\apktool.EXE"
        ? { isFile: () => false }
        : stat(path),
    );
    expect(await resolveApktoolCommand(environment, "win32")).toMatchObject({
      command: "C:\\Other Tools\\apktool.EXE",
    });
  });

  it("preserves inspection failures instead of reporting a missing command or selecting a later file", async () => {
    lookup.stat.mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    const failure = await resolveApktoolCommand(environment, "win32").catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ApktoolConfigurationFailure);
    if (!(failure instanceof ApktoolConfigurationFailure)) throw failure;
    expect(failure).toMatchObject({
      code: "command_unresolved",
      diagnostics: {
        candidate_path: "C:\\Selected Tools\\apktool.EXE",
        filesystem_error: "EACCES",
      },
    });
    expect(apktoolConfigurationAvailability(failure)).toMatchObject({
      code: "not_configured",
    });
    expect(lookup.stat).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before inspecting launchers", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveApktoolCommand(environment, "win32", controller.signal),
    ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
    expect(lookup.stat).not.toHaveBeenCalled();
  });
});

it("does not select a launcher when cancellation arrives during lookup", async () => {
  const controller = new AbortController();
  lookup.stat.mockImplementation(async () => {
    controller.abort();
    return { isFile: () => true };
  });
  await expect(
    resolveApktoolCommand(
      {
        PATH: "C:\\Tools",
        PATHEXT: ".CMD",
        NoDefaultCurrentDirectoryInExePath: "1",
      },
      "win32",
      controller.signal,
    ),
  ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
  expect(lookup.stat).toHaveBeenCalledTimes(1);
});

it.each(["EXE", ".CMD\\..\\outside.exe", ".CMD\0"])(
  "rejects malformed PATHEXT %j before path lookup",
  async (PATHEXT) => {
    await expect(
      resolveApktoolCommand({ PATH: "C:\\Tools", PATHEXT }, "win32"),
    ).rejects.toMatchObject({
      code: "command_unresolved",
      diagnostics: { invalid_extension: PATHEXT },
    });
    expect(lookup.stat).not.toHaveBeenCalled();
  },
);

it("cancels a pending filesystem lookup and owns its eventual rejection", async () => {
  const controller = new AbortController();
  let started!: () => void;
  let rejectLookup!: (cause: Error) => void;
  const pendingStat = new Promise((_resolve, reject) => {
    rejectLookup = reject;
  });
  const observed = new Promise<void>((resolve) => {
    started = resolve;
  });
  lookup.stat.mockImplementation(() => {
    started();
    return pendingStat;
  });
  const pending = resolveApktoolCommand(
    {
      PATH: "C:\\Tools",
      PATHEXT: ".CMD",
      NODEFAULTCURRENTDIRECTORYINEXEPATH: "1",
    },
    "win32",
    controller.signal,
  );
  await observed;
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  rejectLookup(new Error("filesystem completed after cancellation"));
  await Promise.resolve();
  expect(lookup.stat).toHaveBeenCalledTimes(1);
});

it("bounds the entire pending PATH lookup by the selection deadline", async () => {
  vi.useFakeTimers();
  try {
    lookup.stat.mockReturnValue(new Promise(() => {}));
    const failure = expect(
      resolveApktoolCommand(
        {
          PATH: "C:\\Tools",
          PATHEXT: ".CMD",
          NODEFAULTCURRENTDIRECTORYINEXEPATH: "1",
        },
        "win32",
      ),
    ).rejects.toMatchObject({
      _tag: "AnalysisTimeoutError",
      timeoutMs: 20_000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await failure;
    expect(lookup.stat).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
