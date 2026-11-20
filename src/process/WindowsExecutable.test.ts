import { beforeEach, expect, it, vi } from "vitest";

import { findWindowsExecutable } from "./WindowsExecutable.js";

const lookup = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: lookup.stat }));
beforeEach(() => lookup.stat.mockReset());
const options = () => ({
  signal: new AbortController().signal,
  cwd: "C:\\project",
});

it("selects an executable in the earlier PATH entry even when another extension ranks first", async () => {
  lookup.stat.mockImplementation(async (path: string) => ({
    isFile: () => ["C:\\tools\\adb.EXE", "D:\\tools\\adb.COM"].includes(path),
  }));
  expect(
    await findWindowsExecutable(
      "adb",
      { Path: "C:\\tools;D:\\tools", PathExt: ".CMD;.COM;.EXE" },
      options(),
    ),
  ).toEqual({ ok: true, value: "C:\\tools\\adb.EXE" });
});

it.each([{}, { PATH: "" }, { PATH: ';"";;' }])(
  "returns a missing result without probing implicit CWD for %j",
  async (environment) => {
    expect(await findWindowsExecutable("adb", environment, options())).toEqual({
      ok: false,
      error: { kind: "missing" },
    });
    expect(lookup.stat).not.toHaveBeenCalled();
  },
);

it("retains the failed candidate and cause rather than selecting a later executable", async () => {
  const cause = Object.assign(new Error("denied"), { code: "EACCES" });
  lookup.stat
    .mockRejectedValueOnce(cause)
    .mockResolvedValue({ isFile: () => true });
  expect(
    await findWindowsExecutable(
      "adb",
      { PATH: "C:\\tools;D:\\tools", PATHEXT: ".EXE" },
      options(),
    ),
  ).toEqual({
    ok: false,
    error: {
      kind: "inspection",
      path: "C:\\tools\\adb.EXE",
      code: "EACCES",
      cause,
    },
  });
});

it.each([true, false])(
  "uses only the qualified location when the executable is present there: %s",
  async (present) => {
    const qualified = "C:\\project\\.venv\\Scripts\\python.EXE";
    lookup.stat.mockImplementation(async (path: string) => ({
      isFile: () =>
        (present && path === qualified) || path === "C:\\tools\\python.COM",
    }));
    expect(
      await findWindowsExecutable(
        ".venv\\Scripts\\python",
        { PATH: "C:\\tools", PATHEXT: ".COM;.EXE" },
        options(),
      ),
    ).toEqual(
      present
        ? { ok: true, value: qualified }
        : { ok: false, error: { kind: "missing" } },
    );
  },
);
