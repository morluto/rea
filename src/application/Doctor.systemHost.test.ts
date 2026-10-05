import { expect, it } from "vitest";

import { systemDoctorHost } from "./Doctor.js";

it("threads the selected host and environment into system diagnostics", async () => {
  const environment = {
    HOME: "/selected/home",
    HOPPER_LAUNCHER_PATH: "/selected/bin/hopper",
    PATH: "/selected/bin",
  };
  const calls: Array<{
    command: string;
    arguments: readonly string[];
    environment: NodeJS.ProcessEnv | undefined;
  }> = [];
  const host = systemDoctorHost({
    platform: "linux",
    architecture: "x64",
    environment,
    execFileOutput: async (command, arguments_, options) => {
      calls.push({ command, arguments: arguments_, environment: options?.env });
      if (command === "sw_vers") return { stdout: "15.0\n", stderr: "" };
      if (command === "ldd") return { stdout: "linux-vdso.so.1", stderr: "" };
      return { stdout: "/selected/bin/rea\n", stderr: "" };
    },
  });

  expect(host.homeDirectory).toBe("/selected/home");
  expect(host.platform).toBe("linux");
  expect(host.architecture).toBe("x64");
  await host.installationPaths?.();
  await host.macosVersion();
  await host.executable(process.execPath);

  expect(calls.map(({ command }) => command)).toEqual([
    "which",
    "sw_vers",
    "ldd",
  ]);
  expect(
    calls.every(({ environment: observed }) => observed === environment),
  ).toBe(true);
});
