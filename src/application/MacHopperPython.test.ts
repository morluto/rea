import { describe, expect, it } from "vitest";
import {
  macHopperPythonCheck,
  macHopperPythonCommandEnvironment,
  readMacHopperPythonFacts,
  type MacHopperPythonFacts,
  type MacHopperPythonHost,
} from "./MacHopperPython.js";

const LAUNCHER = "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const BUNDLE = "com.cryptic-apps.hopper-web-4";
const CLT = "/Library/Developer/CommandLineTools";
const PYTHON_ORG = "/Library/Frameworks/Python.framework/Versions/3.13/Python";
const CLT_PYTHON = `${CLT}/Library/Frameworks/Python3.framework/Versions/3.9/Python3`;

const commandFailure = (stderr: string, code: number) =>
  Object.assign(new Error("command failed"), {
    stdout: "",
    stderr,
    code,
    signal: null,
    killed: false,
    outputTruncated: false,
  });

/** A host whose commands, files and directories are fixed by the test. */
const fakeHost = ({
  pythonPath,
  files,
  unreadable = [],
}: {
  readonly pythonPath: string | Error;
  readonly files: readonly string[];
  /** Paths whose probe fails for a reason other than absence. */
  readonly unreadable?: readonly string[];
}): MacHopperPythonHost & { readonly commands: string[][] } => {
  const commands: string[][] = [];
  const output = (stdout: string) =>
    Promise.resolve({
      stdout,
      stderr: "",
      stdoutBytes: stdout.length,
      stderrBytes: 0,
    });
  return {
    commands,
    env: {},
    run: (command, arguments_) => {
      commands.push([command, ...arguments_]);
      if (command === "/usr/bin/xcode-select") return output(`${CLT}\n`);
      if (arguments_[2] === "CFBundleIdentifier") return output(`${BUNDLE}\n`);
      if (arguments_[2] === "PythonPath")
        return typeof pythonPath === "string"
          ? output(`${pythonPath}\n`)
          : Promise.reject(pythonPath);
      return Promise.reject(new Error(`unexpected command ${command}`));
    },
    fileState: (path) =>
      Promise.resolve(
        unreadable.includes(path)
          ? { state: "unknown", reason: `EACCES: permission denied, '${path}'` }
          : files.includes(path)
            ? { state: "file" }
            : { state: "missing" },
      ),
    listDirectory: (path) => {
      if (unreadable.includes(path))
        return Promise.resolve({
          state: "unknown",
          reason: `EACCES: permission denied, '${path}'`,
        });
      const entries = [
        ...new Set(
          files
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1).split("/")[0] ?? ""),
        ),
      ];
      return Promise.resolve(
        entries.length === 0
          ? { state: "missing" }
          : { state: "listed", entries: [...entries, "Current"] },
      );
    },
  };
};

const unsetPythonPath = commandFailure(
  `The domain/default pair of (${BUNDLE}, PythonPath) does not exist`,
  1,
);

describe("macOS Hopper Python facts", () => {
  it("reports an unset PythonPath and the frameworks Hopper can find", async () => {
    const host = fakeHost({
      pythonPath: unsetPythonPath,
      files: [PYTHON_ORG, CLT_PYTHON],
    });
    const facts = await readMacHopperPythonFacts(host, LAUNCHER);

    expect(facts).toEqual({
      bundleIdentifier: BUNDLE,
      pythonPath: { state: "unset" },
      searchedRoots: [
        "/Library/Frameworks/Python.framework",
        "/usr/local/Frameworks/Python.framework",
        `${CLT}/Library/Frameworks/Python3.framework`,
      ],
      frameworks: [PYTHON_ORG, CLT_PYTHON],
      unreadable: [],
    });
    expect(host.commands).toContainEqual([
      "/usr/bin/defaults",
      "read",
      "/Applications/Hopper Disassembler.app/Contents/Info",
      "CFBundleIdentifier",
    ]);
  });

  it("records whether PythonPath names a file, a missing path, or an unreadable path", async () => {
    const missing = await readMacHopperPythonFacts(
      fakeHost({ pythonPath: "/missing/Python", files: [PYTHON_ORG] }),
      LAUNCHER,
    );
    const unreadable = await readMacHopperPythonFacts(
      fakeHost({
        pythonPath: "/locked/Python",
        files: [],
        unreadable: ["/locked/Python"],
      }),
      LAUNCHER,
    );

    expect(missing.pythonPath).toEqual({
      state: "set",
      path: "/missing/Python",
      file: { state: "missing" },
    });
    expect(unreadable.pythonPath).toEqual({
      state: "set",
      path: "/locked/Python",
      file: {
        state: "unknown",
        reason: "EACCES: permission denied, '/locked/Python'",
      },
    });
  });

  it("reports framework roots that could not be read instead of treating them as empty", async () => {
    const versions = "/Library/Frameworks/Python.framework/Versions";
    const facts = await readMacHopperPythonFacts(
      fakeHost({
        pythonPath: unsetPythonPath,
        files: [],
        unreadable: [versions],
      }),
      LAUNCHER,
    );

    expect(facts.frameworks).toEqual([]);
    expect(facts.unreadable).toEqual([
      { path: versions, reason: `EACCES: permission denied, '${versions}'` },
    ]);
  });

  it("reads a renamed bundle whose extension differs in case, as discovery accepts it", async () => {
    const host = fakeHost({ pythonPath: unsetPythonPath, files: [PYTHON_ORG] });
    const facts = await readMacHopperPythonFacts(
      host,
      "/Users/analyst/Applications/Hopper.APP/Contents/MacOS/hopper",
    );

    expect(facts.bundleIdentifier).toBe(BUNDLE);
    expect(facts.pythonPath).toEqual({ state: "unset" });
    expect(host.commands).toContainEqual([
      "/usr/bin/defaults",
      "read",
      "/Users/analyst/Applications/Hopper.APP/Contents/Info",
      "CFBundleIdentifier",
    ]);
  });

  it("keeps PythonPath unknown when the launcher is outside an app bundle", async () => {
    const host = fakeHost({ pythonPath: unsetPythonPath, files: [] });
    const facts = await readMacHopperPythonFacts(host, "/usr/local/bin/hopper");

    expect(facts.bundleIdentifier).toBeUndefined();
    expect(facts.pythonPath.state).toBe("unknown");
    expect(host.commands.some((command) => command[2] === "PythonPath")).toBe(
      false,
    );
  });

  it("keeps PythonPath unknown when defaults fails for another reason", async () => {
    const facts = await readMacHopperPythonFacts(
      fakeHost({
        pythonPath: commandFailure("defaults: unreadable domain", 2),
        files: [],
      }),
      LAUNCHER,
    );

    expect(facts.pythonPath).toEqual({
      state: "unknown",
      reason: `defaults read ${BUNDLE} PythonPath failed: defaults: unreadable domain`,
    });
  });

  it("propagates failures that are not command results", async () => {
    const cancelled = new Error("cancelled");
    await expect(
      readMacHopperPythonFacts(
        fakeHost({ pythonPath: cancelled, files: [] }),
        LAUNCHER,
      ),
    ).rejects.toBe(cancelled);
  });
});

describe("macOS Hopper Python check", () => {
  const facts = (
    overrides: Partial<MacHopperPythonFacts>,
  ): MacHopperPythonFacts => ({
    bundleIdentifier: BUNDLE,
    pythonPath: { state: "unset" },
    searchedRoots: ["/Library/Frameworks/Python.framework"],
    frameworks: [],
    unreadable: [],
    ...overrides,
  });

  it("names the configured interpreter when PythonPath exists", () => {
    const check = macHopperPythonCheck(
      facts({
        pythonPath: {
          state: "set",
          path: PYTHON_ORG,
          file: { state: "file" },
        },
      }),
    );

    expect(check).toMatchObject({
      name: "hopper-python",
      ok: true,
      classification: "healthy",
      details: { hopper_interpreter: PYTHON_ORG },
    });
  });

  it("fails a PythonPath that names a missing file, even with frameworks present", () => {
    const check = macHopperPythonCheck(
      facts({
        pythonPath: {
          state: "set",
          path: "/missing/Python",
          file: { state: "missing" },
        },
        frameworks: [PYTHON_ORG],
      }),
    );

    expect(check).toMatchObject({
      name: "hopper-python",
      ok: false,
      classification: "config_drift",
    });
    expect(check.remediation).toContain(`defaults delete ${BUNDLE} PythonPath`);
  });

  it("keeps an unreadable PythonPath unknown instead of reporting it missing", () => {
    const check = macHopperPythonCheck(
      facts({
        pythonPath: {
          state: "set",
          path: "/locked/Python",
          file: { state: "unknown", reason: "EACCES: permission denied" },
        },
        frameworks: [PYTHON_ORG],
      }),
    );

    expect(check).toMatchObject({
      name: "hopper-python",
      ok: false,
      classification: "unknown",
      details: {
        python_path: {
          state: "set",
          file: "unknown",
          reason: "EACCES: permission denied",
        },
      },
    });
    expect(check.remediation).not.toContain("defaults delete");
  });

  it("does not let other frameworks settle readiness when PythonPath could not be read", () => {
    const check = macHopperPythonCheck(
      facts({
        pythonPath: { state: "unknown", reason: "defaults failed" },
        frameworks: [PYTHON_ORG],
      }),
    );

    expect(check).toMatchObject({
      name: "hopper-python",
      ok: false,
      classification: "unknown",
      details: { hopper_interpreter: "unknown" },
    });
    expect(check.detail).toContain("defaults failed");
  });

  it("keeps the interpreter unknown when only framework candidates are observed", () => {
    const check = macHopperPythonCheck(facts({ frameworks: [PYTHON_ORG] }));

    expect(check).toMatchObject({
      name: "hopper-python",
      ok: true,
      classification: "healthy",
      details: { hopper_interpreter: "unknown", frameworks: [PYTHON_ORG] },
    });
  });

  it("reports an unknown failure, naming unchecked roots, when no framework is found", () => {
    const versions = "/Library/Frameworks/Python.framework/Versions";
    const check = macHopperPythonCheck(
      facts({ unreadable: [{ path: versions, reason: "EACCES" }] }),
    );

    expect(check).toMatchObject({
      name: "hopper-python",
      ok: false,
      classification: "unknown",
      details: {
        hopper_interpreter: "unknown",
        frameworks: [],
        unreadable: [{ path: versions, reason: "EACCES" }],
      },
    });
    expect(check.detail).toContain(`could not check ${versions}`);
    expect(check.remediation).toContain("Cannot execute Python script");
    expect(check.remediation).toContain(`defaults write ${BUNDLE} PythonPath`);
  });
});

describe("macOS Hopper Python command environment", () => {
  it("passes only HOME and DEVELOPER_DIR with a fixed system PATH", () => {
    expect(
      macHopperPythonCommandEnvironment({
        HOME: "/Users/analyst",
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
        PATH: "/opt/custom/bin",
        CALLER_SETTING: "private\u0000value",
      }),
    ).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/Users/analyst",
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    });
  });

  it("omits empty or malformed selected settings", () => {
    expect(
      macHopperPythonCommandEnvironment({
        HOME: "",
        DEVELOPER_DIR: "/broken\u0000dir",
      }),
    ).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  });
});
