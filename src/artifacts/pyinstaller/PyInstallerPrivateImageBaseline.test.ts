import { expect, it, vi } from "vitest";

import { withPyInstallerReader } from "../../../tests/fixtures/pyinstallerReader.js";
import { openRegularFile } from "../../filesystem/RegularFile.js";
import {
  cArchiveExecutable,
  pyzArchive,
  PYTHON_39_MAGIC,
} from "./CArchive.fixture.js";

const recordedSleeps = vi.hoisted(() => [] as number[]);

vi.mock("../../filesystem/ChangeTimeBaseline.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../filesystem/ChangeTimeBaseline.js")
    >();
  return {
    ...actual,
    settleChangeTimeBaseline: (
      read: Parameters<typeof actual.settleChangeTimeBaseline>[0],
      seams?: Parameters<typeof actual.settleChangeTimeBaseline>[1],
    ) =>
      actual.settleChangeTimeBaseline(read, {
        ...seams,
        // A frozen Windows clock keeps a fresh ChangeTime inside the drift
        // window, so a real settle records one sleep per poll.
        platform: "win32",
        now: () => 0,
        sleep: async (delayMs: number) => {
          recordedSleeps.push(delayMs);
        },
      }),
  };
});

it("does not settle ChangeTime for a private compressed PYZ image", async () => {
  const bytes = cArchiveExecutable({
    layout: "2.1",
    pythonVersion: 309,
    pythonLibrary: "libpython3.9.so",
    members: [
      {
        name: "PYZ.pyz",
        typeCode: "z",
        compress: true,
        payload: pyzArchive({
          magic: PYTHON_39_MAGIC,
          modules: [{ name: "child", typeCode: 0, body: Buffer.from("child") }],
        }),
      },
    ],
  });
  await withPyInstallerReader(bytes, async (reader, _handle, path) => {
    recordedSleeps.length = 0;
    const paths: string[] = [];
    for await (const entry of reader.entries()) paths.push(entry.path);
    expect(paths.some((entry) => entry.endsWith("child.pyc"))).toBe(true);
    expect(recordedSleeps).toEqual([]);

    recordedSleeps.length = 0;
    const admitted = await openRegularFile(path, { symlinks: "reject" });
    await admitted.handle.close();
    expect(recordedSleeps.length).toBeGreaterThan(0);
    expect(recordedSleeps.every((delayMs) => delayMs === 25)).toBe(true);
  });
});
