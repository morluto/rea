import { describe, expect, it } from "vitest";

import { defaultHopperLauncherPath } from "./HopperLauncherDiscovery.js";

describe("default Linux Hopper launcher", () => {
  const home = "/fixture/home";
  const withExecutables =
    (paths: readonly string[]) =>
    (path: string): boolean =>
      paths.includes(path);

  it.each([
    [
      "/opt/hopper-v4/bin/hopper",
      ["/usr/bin/hopper", "/opt/hopper-v4/bin/hopper"],
    ],
    ["/usr/bin/hopper", ["/usr/bin/hopper"]],
  ])(
    "selects system launcher %s when those candidates exist",
    (expected, present) => {
      expect(
        defaultHopperLauncherPath("linux", home, withExecutables(present)),
      ).toBe(expected);
    },
  );

  it("prefers REA-managed and user-local launchers over system paths", () => {
    expect(
      defaultHopperLauncherPath(
        "linux",
        home,
        withExecutables([
          "/opt/hopper/bin/Hopper",
          `${home}/.local/share/rea/hopper/bin/Hopper`,
          "/opt/hopper-v4/bin/hopper",
          "/usr/bin/hopper",
        ]),
      ),
    ).toBe("/opt/hopper/bin/Hopper");
    expect(
      defaultHopperLauncherPath(
        "linux",
        home,
        withExecutables([
          `${home}/.local/share/rea/hopper/bin/Hopper`,
          "/usr/bin/hopper",
        ]),
      ),
    ).toBe(`${home}/.local/share/rea/hopper/bin/Hopper`);
  });
});

describe("default macOS Hopper launcher", () => {
  it("selects the system path before the installer user path", () => {
    const home = "/fixture/home";
    const system =
      "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
    const user =
      "/fixture/home/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
    const executable = (path: string): boolean =>
      path === system || path === user;

    expect(defaultHopperLauncherPath("darwin", home, executable)).toBe(system);
    expect(
      defaultHopperLauncherPath("darwin", home, (path) => path === user),
    ).toBe(user);
  });
});
