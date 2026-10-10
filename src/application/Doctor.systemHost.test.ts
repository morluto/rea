import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
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

it("does not report a directory as an available executable", async () => {
  const host = systemDoctorHost({
    platform: "darwin",
    architecture: "arm64",
    environment: {},
    execFileOutput: () => Promise.reject(new Error("unexpected command")),
  });

  await expect(host.executable(dirname(process.execPath))).resolves.toBe(false);
  await expect(host.executable(process.execPath)).resolves.toBe(true);
});

it.each([
  [{ default: { appdir: "/Applications" } }, "/Applications"],
  [
    {
      default: { appdir: "/Applications" },
      env: { appdir: "/Env Apps" },
      explicit: { appdir: "~/Tools" },
    },
    "HOME/Tools",
  ],
  [
    { default: { appdir: "/Applications" }, env: { appdir: "/Env Apps" } },
    "/Env Apps",
  ],
])(
  "locates the Hopper cask from its Caskroom receipt without a cask command (%j)",
  async (config, expectedAppdir) => {
    const root = await createTestTempDirectory("rea-doctor-caskroom-");
    const caskroom = join(root, "Caskroom");
    const metadata = join(caskroom, "hopper-disassembler", ".metadata");
    await mkdir(metadata, { recursive: true });
    await writeFile(join(metadata, "config.json"), JSON.stringify(config));
    const calls: (readonly string[])[] = [];
    const host = systemDoctorHost({
      platform: "darwin",
      environment: { HOME: join(root, "home") },
      execFileOutput: async (_command, arguments_) => {
        calls.push(arguments_);
        return { stdout: `${caskroom}\n`, stderr: "" };
      },
    });

    expect(await host.brewHopperPath()).toBe(
      join(
        expectedAppdir.replace("HOME", join(root, "home")),
        "Hopper Disassembler.app/Contents/MacOS/hopper",
      ),
    );
    // A cask argument makes Homebrew fetch and cache its API data.
    expect(calls).toEqual([["--caskroom"]]);
  },
);

it("reports no Homebrew Hopper when the cask has no receipt", async () => {
  const caskroom = await createTestTempDirectory("rea-doctor-caskroom-");
  const calls: (readonly string[])[] = [];
  const host = systemDoctorHost({
    platform: "darwin",
    environment: { HOME: caskroom },
    execFileOutput: async (_command, arguments_) => {
      calls.push(arguments_);
      return { stdout: `${caskroom}\n`, stderr: "" };
    },
  });

  expect(await host.brewHopperPath()).toBeUndefined();
  expect(
    calls.every((arguments_) => arguments_.join(" ") === "--caskroom"),
  ).toBe(true);
});
