import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { execFileOutput } from "../process/ExecFileOutput.js";
import {
  createMacHopperPythonHost,
  inspectMacHopperPython,
  type MacHopperPythonHost,
} from "./MacHopperPython.js";

const LAUNCHER = "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const BUNDLE = "com.cryptic-apps.hopper-web-4";
const CLT = "/Library/Developer/CommandLineTools";
const VERSIONS = "/Library/Frameworks/Python.framework/Versions";
const PYTHON_ORG = `${VERSIONS}/3.13/Python`;
const CLT_PYTHON = `${CLT}/Library/Frameworks/Python3.framework/Versions/3.9/Python3`;
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;

const commandFailure = (stderr: string, code: number) =>
  Object.assign(new Error("command failed"), {
    stdout: "",
    stderr,
    code,
    signal: null,
    killed: false,
    outputTruncated: false,
  });
const unset = commandFailure(
  `The domain/default pair of (${BUNDLE}, PythonPath) does not exist`,
  1,
);

type Image = Awaited<ReturnType<MacHopperPythonHost["image"]>>;

/** A host whose commands and paths are fixed by the test. */
const fakeHost = ({
  pythonPath = unset,
  images = {},
  listings = {},
  resolvePath = (path) => Promise.resolve({ state: "resolved", path }),
}: {
  readonly pythonPath?: string | Error;
  readonly images?: Readonly<Record<string, Image>>;
  readonly listings?: Readonly<
    Record<string, Awaited<ReturnType<MacHopperPythonHost["listDirectory"]>>>
  >;
  readonly resolvePath?: MacHopperPythonHost["resolvePath"];
} = {}): MacHopperPythonHost & { readonly commands: string[][] } => {
  const commands: string[][] = [];
  return {
    commands,
    run: (command, arguments_) => {
      commands.push([command, ...arguments_]);
      if (command === "/usr/bin/xcode-select")
        return Promise.resolve({ stdout: `${CLT}\n` });
      if (arguments_[2] === "CFBundleIdentifier")
        return Promise.resolve({ stdout: `${BUNDLE}\n` });
      return typeof pythonPath === "string"
        ? Promise.resolve({ stdout: `${pythonPath}\n` })
        : Promise.reject(pythonPath);
    },
    resolvePath,
    image: (path) => Promise.resolve(images[path] ?? { state: "missing" }),
    listDirectory: (path) =>
      Promise.resolve(listings[path] ?? { state: "missing" }),
  };
};
const installed = {
  images: {
    [PYTHON_ORG]: { state: "compatible" },
    [CLT_PYTHON]: { state: "compatible" },
  },
  listings: {
    [VERSIONS]: { state: "listed", entries: ["3.13", "Current"] },
    [`${CLT}/Library/Frameworks/Python3.framework/Versions`]: {
      state: "listed",
      entries: ["3.9", "Current"],
    },
  },
} as const;

describe("macOS Hopper Python check", () => {
  it("reports compatible candidates without claiming which one Hopper loads", async () => {
    const check = await inspectMacHopperPython(fakeHost(installed), LAUNCHER);

    expect(check).toMatchObject({
      name: "hopper-python",
      ok: true,
      classification: "unknown",
      details: {
        hopper_interpreter: "unknown",
        bundle_identifier: BUNDLE,
        python_path: { state: "unset" },
        frameworks: [PYTHON_ORG, CLT_PYTHON],
        rejected: [],
        unreadable: [],
      },
    });
  });

  it("does not treat a compatible PythonPath image as proof that Hopper loads Python", async () => {
    const check = await inspectMacHopperPython(
      fakeHost({
        pythonPath: "/lib/libcrypto.dylib",
        images: { "/lib/libcrypto.dylib": { state: "compatible" } },
      }),
      LAUNCHER,
    );

    expect(check).toMatchObject({
      ok: true,
      classification: "unknown",
      details: {
        hopper_interpreter: "unknown",
        python_path: { state: "set", image: "compatible" },
      },
    });
  });

  it.each<readonly [string, Image]>([
    ["missing", { state: "missing" }],
    ["incompatible", { state: "incompatible", reason: "not a Mach-O image" }],
  ])(
    "fails a %s PythonPath even when other frameworks are usable",
    async (state, image) => {
      const check = await inspectMacHopperPython(
        fakeHost({
          ...installed,
          pythonPath: "/selected/Python",
          images: { ...installed.images, "/selected/Python": image },
        }),
        LAUNCHER,
      );

      expect(check).toMatchObject({
        ok: false,
        classification: "config_drift",
        details: { python_path: { state: "set", image: state } },
      });
      expect(check.remediation).toContain(
        `defaults delete ${BUNDLE} PythonPath`,
      );
    },
  );

  it("keeps an unreadable PythonPath unknown instead of advising its removal", async () => {
    const check = await inspectMacHopperPython(
      fakeHost({
        ...installed,
        pythonPath: "/locked/Python",
        images: {
          ...installed.images,
          "/locked/Python": { state: "unknown", reason: "EACCES" },
        },
      }),
      LAUNCHER,
    );

    expect(check).toMatchObject({
      ok: false,
      classification: "unknown",
      details: { python_path: { image: "unknown", reason: "EACCES" } },
    });
    expect(check.remediation).not.toContain("defaults delete");
  });

  it("does not let frameworks settle readiness when PythonPath could not be read", async () => {
    const check = await inspectMacHopperPython(
      fakeHost({ ...installed, pythonPath: commandFailure("unreadable", 2) }),
      LAUNCHER,
    );

    expect(check).toMatchObject({
      ok: false,
      classification: "unknown",
      details: {
        python_path: {
          state: "unknown",
          reason: `defaults read ${BUNDLE} PythonPath failed: unreadable`,
        },
      },
    });
  });

  it("separates rejected and unreadable candidates from absent ones", async () => {
    const check = await inspectMacHopperPython(
      fakeHost({
        images: {
          [PYTHON_ORG]: { state: "incompatible", reason: "wrong slice" },
        },
        listings: {
          [VERSIONS]: { state: "listed", entries: ["3.13"] },
          "/usr/local/Frameworks/Python.framework/Versions": {
            state: "unknown",
            reason: "EACCES",
          },
        },
      }),
      LAUNCHER,
    );

    expect(check).toMatchObject({
      ok: false,
      classification: "unknown",
      details: {
        frameworks: [],
        rejected: [{ path: PYTHON_ORG, reason: "wrong slice" }],
        unreadable: [
          {
            path: "/usr/local/Frameworks/Python.framework/Versions",
            reason: "EACCES",
          },
        ],
      },
    });
  });

  it("propagates failures that are not command results", async () => {
    const cancelled = new Error("cancelled");
    await expect(
      inspectMacHopperPython(fakeHost({ pythonPath: cancelled }), LAUNCHER),
    ).rejects.toBe(cancelled);
  });
});

describe("macOS Hopper bundle identity", () => {
  it.each([
    ["an executable symlink", "/usr/local/bin/hopper", LAUNCHER],
    [
      "a lexical alias",
      "/Applications/Hopper Disassembler.app/Contents/./MacOS/hopper",
      LAUNCHER,
    ],
    [
      "a mixed-case renamed bundle",
      "/Apps/Hopper.APP/Contents/MacOS/hopper",
      "/Apps/Hopper.APP/Contents/MacOS/hopper",
    ],
  ])("identifies the bundle behind %s", async (_case, selected, resolved) => {
    const host = fakeHost({
      ...installed,
      resolvePath: (path) =>
        Promise.resolve(
          path === selected
            ? { state: "resolved", path: resolved }
            : { state: "unknown", reason: "unexpected path" },
        ),
    });
    const check = await inspectMacHopperPython(host, selected);

    expect(check).toMatchObject({
      ok: true,
      details: { bundle_identifier: BUNDLE },
    });
    expect(host.commands).toContainEqual([
      "/usr/bin/defaults",
      "read",
      resolved.replace("/MacOS/hopper", "/Info"),
      "CFBundleIdentifier",
    ]);
  });

  it.each<readonly [string, MacHopperPythonHost["resolvePath"]]>([
    [
      "outside a bundle",
      () => Promise.resolve({ state: "resolved", path: "/opt/bin/hopper" }),
    ],
    [
      "that cannot be resolved",
      () => Promise.resolve({ state: "unknown", reason: "EACCES" }),
    ],
  ])(
    "keeps PythonPath unknown for a launcher %s",
    async (_case, resolvePath) => {
      const host = fakeHost({ ...installed, resolvePath });
      const check = await inspectMacHopperPython(host, LAUNCHER);

      expect(check).toMatchObject({
        ok: false,
        classification: "unknown",
        details: { bundle_identifier: null },
      });
      expect(
        host.commands.some((command) => command[0]?.includes("defaults")),
      ).toBe(false);
    },
  );
});

/** Headers of the images that Hopper 6.6.2 accepted or refused (#7954). */
const thin = (cpuType: number, fileType: number): Buffer => {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  header.writeUInt32LE(fileType, 12);
  return header;
};
const fat = (...cpuTypes: readonly number[]): Buffer => {
  const header = Buffer.alloc(8 + cpuTypes.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpuType, index) => {
    const entry = 8 + index * 20;
    header.writeUInt32BE(cpuType, entry);
    header.writeUInt32BE(0x4000 * (index + 1), entry + 8);
    header.writeUInt32BE(0x1000, entry + 12);
    header.writeUInt32BE(14, entry + 16);
  });
  return header;
};
const systemHost = (
  architecture: NodeJS.Architecture = "arm64",
  environment: NodeJS.ProcessEnv = {},
  run: typeof execFileOutput = () => Promise.reject(new Error("not run")),
) =>
  createMacHopperPythonHost({
    run,
    environment,
    architecture,
    resourceScope: {
      retain: () => undefined,
      run: (operation) => operation(),
    },
  });

describe("macOS Hopper Python host", () => {
  it.each<readonly [string, NodeJS.Architecture, Buffer, string]>([
    ["an arm64 library", "arm64", thin(ARM64, 6), "compatible"],
    ["a universal library", "arm64", fat(X86_64, ARM64), "compatible"],
    ["a Python executable", "arm64", thin(ARM64, 2), "compatible"],
    ["another architecture", "arm64", thin(X86_64, 6), "incompatible"],
    ["a fat file without this host", "arm64", fat(X86_64), "incompatible"],
    ["text", "arm64", Buffer.from("not a library\n"), "incompatible"],
    ["an empty file", "arm64", Buffer.alloc(0), "incompatible"],
    // x64 REA can run under Rosetta beside a native Hopper.
    ["an arm64 library", "x64", thin(ARM64, 6), "compatible"],
    ["an x86_64 library", "x64", thin(X86_64, 6), "compatible"],
  ])("classifies %s on %s", async (_case, architecture, bytes, state) => {
    const path = join(await createTestTempDirectory("rea-hopper-py-"), "image");
    await writeFile(path, bytes);

    expect((await systemHost(architecture).image(path)).state).toBe(state);
  });

  it("distinguishes directories and absent paths", async () => {
    const root = await createTestTempDirectory("rea-hopper-py-");
    const host = systemHost();

    expect(await host.image(root)).toEqual({
      state: "incompatible",
      reason: "not a regular file",
    });
    await writeFile(join(root, "text"), "not a library\n");
    expect(await host.image(join(root, "text"))).toEqual({
      state: "incompatible",
      reason: "not a Mach-O image",
    });
    expect(await host.image(join(root, "absent"))).toEqual({
      state: "missing",
    });
    expect(await host.listDirectory(join(root, "absent"))).toEqual({
      state: "missing",
    });
    expect((await host.resolvePath(join(root, "absent"))).state).toBe(
      "unknown",
    );
  });

  it.skipIf(process.platform === "win32")(
    "follows library aliases and resolves launcher aliases",
    async () => {
      const root = await createTestTempDirectory("rea-hopper-py-");
      const directory = join(root, "Hopper.app", "Contents", "MacOS");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "hopper"), thin(ARM64, 2));
      await symlink(join(directory, "hopper"), join(root, "alias"));
      const host = systemHost();

      expect(await host.image(join(root, "alias"))).toEqual({
        state: "compatible",
      });
      const direct = await host.resolvePath(join(directory, "hopper"));
      expect(direct.state).toBe("resolved");
      expect(await host.resolvePath(join(root, "alias"))).toEqual(direct);
      expect(
        await host.resolvePath(`${root}/Hopper.app/Contents/./MacOS/hopper`),
      ).toEqual(direct);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps an unreadable image unknown",
    async () => {
      const path = join(
        await createTestTempDirectory("rea-hopper-py-"),
        "image",
      );
      await writeFile(path, thin(ARM64, 6), { mode: 0o000 });

      expect(await systemHost().image(path)).toMatchObject({
        state: "unknown",
      });
    },
  );

  it("propagates cancellation instead of reporting an unknown image", async () => {
    const path = join(await createTestTempDirectory("rea-hopper-py-"), "image");
    await writeFile(path, thin(ARM64, 6));
    const controller = new AbortController();
    controller.abort("stop");
    const host = createMacHopperPythonHost({
      run: () => Promise.reject(new Error("not run")),
      environment: {},
      architecture: "arm64",
      resourceScope: {
        retain: () => undefined,
        run: (operation) => operation(),
      },
      signal: controller.signal,
    });

    await expect(host.image(path)).rejects.toThrow();
  });

  it("passes only HOME and DEVELOPER_DIR with a fixed system PATH", async () => {
    const environments: unknown[] = [];
    const run: typeof execFileOutput = (_command, _arguments, options) => {
      environments.push(options?.env);
      return Promise.resolve({
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
      });
    };
    await systemHost(
      "arm64",
      {
        HOME: "/Users/analyst",
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
        PATH: "/opt/custom/bin",
        CALLER_SETTING: "private\u0000value",
      },
      run,
    ).run("/usr/bin/defaults", []);
    await systemHost(
      "arm64",
      { HOME: "", DEVELOPER_DIR: "/broken\u0000dir" },
      run,
    ).run("/usr/bin/defaults", []);

    expect(environments).toEqual([
      {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: "/Users/analyst",
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      },
      { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    ]);
  });
});
