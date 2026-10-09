import { expect, it } from "vitest";

import { snapshotEnvironment } from "./snapshotEnvironment.js";

it.each(["linux", "darwin"] as const)(
  "preserves case-sensitive %s variables in an immutable snapshot",
  (platform) => {
    const selected = { PATH: "/chosen/bin", Path: "/other/bin" };
    const snapshot = snapshotEnvironment(selected, platform);
    selected.PATH = "/later/bin";
    expect(snapshot).toEqual({ PATH: "/chosen/bin", Path: "/other/bin" });
    expect(Object.isFrozen(snapshot)).toBe(true);
  },
);

it("canonicalizes selected Windows variables without inheriting ambient values", () => {
  const snapshot = snapshotEnvironment(
    { Path: "C:\\selected", ComSpec: "C:\\selected\\cmd.exe" },
    "win32",
  );
  expect(snapshot).toEqual({
    PATH: "C:\\selected",
    COMSPEC: "C:\\selected\\cmd.exe",
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
});

it("uses Node's first lexicographic Windows key even when it is undefined", () => {
  expect(
    snapshotEnvironment(
      {
        path: "lower",
        Path: "mixed",
        PATH: "upper",
        ComSpec: "mixed-cmd",
        COMSPEC: "upper-cmd",
        Temp: "mixed-temp",
        TEMP: undefined,
      },
      "win32",
    ),
  ).toEqual({ PATH: "upper", COMSPEC: "upper-cmd", TEMP: undefined });
});
