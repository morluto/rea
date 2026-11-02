import { delimiter, dirname, relative } from "node:path";

import { expect, it, vi } from "vitest";

import { lookupExecutable } from "../../src/process/ExecutableLookup.js";
import { TestReverseEngineeringService } from "../support/reverseEngineeringService.js";
import {
  rizinExecutableFixture,
  versionProbeCount,
  versionProbeRunner,
} from "../support/rizinToolIdentity.js";

// The selected executable is a POSIX mode-0755 file; Windows resolves
// REA_RIZIN_COMMAND separately and is not covered here.
const posix = it.skipIf(process.platform === "win32");

/** As when the server's working directory has been removed. */
const unreadableWorkingDirectory = () =>
  vi.spyOn(process, "cwd").mockImplementation(() => {
    throw Object.assign(new Error("uv_cwd"), { code: "ENOENT" });
  });

posix(
  "identifies and runs an absolute command and target without reading the working directory",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const run = versionProbeRunner(() => "rizin 0.9.1 @ linux-x86-64");
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      // A relative PATH entry is not searched for an explicit command.
      environment: { REA_RIZIN_COMMAND: executable, PATH: "bin" },
    });
    const cwd = unreadableWorkingDirectory();
    try {
      const result = await service.executeRizinCommand({ path, command: "iI" });
      if (!result.ok) throw result.error;
      expect(result.value.provider.version).toBe("0.9.1");
      expect(result.value.parameters).toMatchObject({
        provider_executable_path: executable,
        provider_identity: "banner",
      });
      expect(cwd).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
    }
  },
);

posix.each([
  ["before", false],
  ["after", true],
] as const)(
  "identifies a PATH match %s a relative entry whose working directory cannot be read",
  async (_order, relativeFirst) => {
    const { executable, path } = await rizinExecutableFixture();
    const run = versionProbeRunner(() => "rizin 0.9.1 @ linux-x86-64");
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: {
        REA_RIZIN_COMMAND: "rizin",
        PATH: relativeFirst
          ? `.${delimiter}${dirname(executable)}`
          : `${dirname(executable)}${delimiter}.`,
      },
    });
    const cwd = unreadableWorkingDirectory();
    try {
      const result = await service.executeRizinCommand({ path, command: "iI" });
      if (!result.ok) throw result.error;
      expect(result.value.provider.version).toBe("0.9.1");
      expect(result.value.parameters).toMatchObject({
        provider_executable_path: executable,
        provider_identity: "banner",
      });
      // A relative entry before the match is reached and skipped.
      expect(cwd).toHaveBeenCalledTimes(relativeFirst ? 1 : 0);
    } finally {
      cwd.mockRestore();
    }
  },
);

posix(
  "runs the command by name, unidentified, when a relative PATH entry before the match still reaches an executable",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const earlier = await rizinExecutableFixture();
    const run = versionProbeRunner(() => "rizin 0.9.1 @ linux-x86-64");
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: {
        REA_RIZIN_COMMAND: "rizin",
        // Relative to the working directory, as `../bin` is.
        PATH: `${relative(process.cwd(), dirname(earlier.executable))}${delimiter}${dirname(executable)}`,
      },
    });
    const cwd = unreadableWorkingDirectory();
    try {
      const result = await service.executeRizinCommand({ path, command: "iI" });
      if (!result.ok) throw result.error;
      expect(result.value.parameters.provider_identity).toBe("assumed");
      expect(result.value.parameters).not.toHaveProperty(
        "provider_executable_path",
      );
      // The later match is not selected: the launch by name follows PATH.
      expect(run.mock.calls.map(([command]) => command)).toEqual(["rizin"]);
      expect(versionProbeCount(run)).toBe(0);
    } finally {
      cwd.mockRestore();
    }
  },
);

posix.each([
  ["a relative command", { REA_RIZIN_COMMAND: "bin/rizin" }],
  ["a relative PATH entry", { REA_RIZIN_COMMAND: "rizin", PATH: "bin" }],
] as const)(
  "returns a result when %s needs a working directory that cannot be read",
  async (_case, environment) => {
    const { path } = await rizinExecutableFixture();
    const run = versionProbeRunner(() => "rizin 0.9.1 @ linux-x86-64");
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment,
    });
    const cwd = unreadableWorkingDirectory();
    try {
      const result = await service.executeRizinCommand({ path, command: "iI" });
      if (!result.ok) throw result.error;
      expect(result.value.provider).toEqual({
        id: "rizin",
        name: "Rizin",
        version: null,
      });
      expect(result.value.parameters.provider_identity).toBe("assumed");
      expect(result.value.parameters).not.toHaveProperty(
        "provider_executable_path",
      );
      expect(versionProbeCount(run)).toBe(0);
      expect(cwd).toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
    }
  },
);
