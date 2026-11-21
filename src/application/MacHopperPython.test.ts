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
}: {
  readonly pythonPath: string | Error;
  readonly files: readonly string[];
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
    isFile: (path) => Promise.resolve(files.includes(path)),
    listDirectory: (path) =>
      Promise.resolve([
        ...new Set(
          files
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1).split("/")[0] ?? ""),
        ),
        ...(files.some((file) => file.startsWith(`${path}/`))
          ? ["Current"]
          : []),
      ]),
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
    });
    expect(host.commands).toContainEqual([
      "/usr/bin/defaults",
      "read",
      "/Applications/Hopper Disassembler.app/Contents/Info",
      "CFBundleIdentifier",
    ]);
  });

  it("records a PythonPath that names a missing file", async () => {
    const facts = await readMacHopperPythonFacts(
      fakeHost({ pythonPath: "/missing/Python", files: [PYTHON_ORG] }),
      LAUNCHER,
    );

    expect(facts.pythonPath).toEqual({
      state: "set",
      path: "/missing/Python",
      exists: false,
    });
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
    ...overrides,
  });

  it("names the configured interpreter when PythonPath exists", () => {
    const check = macHopperPythonCheck(
      facts({ pythonPath: { state: "set", path: PYTHON_ORG, exists: true } }),
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
        pythonPath: { state: "set", path: "/missing/Python", exists: false },
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

  it("keeps the interpreter unknown when only framework candidates are observed", () => {
    const check = macHopperPythonCheck(facts({ frameworks: [PYTHON_ORG] }));

    expect(check).toMatchObject({
      name: "hopper-python",
      ok: true,
      classification: "healthy",
      details: { hopper_interpreter: "unknown", frameworks: [PYTHON_ORG] },
    });
  });

  it("reports an unknown failure when no framework is found", () => {
    const check = macHopperPythonCheck(facts({}));

    expect(check).toMatchObject({
      name: "hopper-python",
      ok: false,
      classification: "unknown",
      details: { hopper_interpreter: "unknown", frameworks: [] },
    });
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
