import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { fetchHomeFolder } from "./BuildComputerController.js";

const MIB = 1024 * 1024;
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** A computer whose controller lists `files` into a file beside the folder and whose data/get answers them, noting each fetch of a file. */
const computer = (files: ReadonlyMap<string, Buffer>, steps: string[]) => {
  const listing = Buffer.from(
    JSON.stringify({
      files: [...files].map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: sha256(bytes),
      })),
      skipped: [],
    }),
  );
  return {
    exec: () =>
      Promise.resolve({
        exit_code: 0,
        stdout: `${JSON.stringify({ listing_bytes: listing.length })}\n`,
        stderr: "",
        truncated: false,
        timed_out: false,
      }),
    redacted: (text: string) => text,
    homeFiles: (paths: readonly string[], bytes: number) => {
      if (paths[0]?.endsWith(".listing.json") === true)
        return Promise.resolve(new Map([[paths[0], listing]]));
      steps.push(`get ${paths.join(",")} within ${String(bytes)}`);
      return Promise.resolve(
        new Map(
          paths.map((path) => [path, files.get(path) ?? Buffer.alloc(0)]),
        ),
      );
    },
  };
};

describe("fetchHomeFolder", () => {
  it("hands over each checked batch before asking for the next, so one batch at a time is held", async () => {
    const files = new Map([
      [".rea-build/b/a", Buffer.alloc(5 * MIB, 1)],
      [".rea-build/b/b", Buffer.alloc(4 * MIB, 2)],
      [".rea-build/b/c", Buffer.alloc(1 * MIB, 3)],
    ]);
    const steps: string[] = [];
    await fetchHomeFolder(computer(files, steps), ".rea-build/b", {
      file: (file) => {
        steps.push(`write ${file.path}`);
        return Promise.resolve();
      },
    });
    expect(steps).toEqual([
      `get .rea-build/b/a within ${String(5 * MIB)}`,
      "write a",
      `get .rea-build/b/b,.rea-build/b/c within ${String(5 * MIB)}`,
      "write b",
      "write c",
    ]);
  });

  it("refuses a file that differs from its listing before handing it over", async () => {
    const files = new Map([[".rea-build/b/a", Buffer.from("seed")]]);
    const steps: string[] = [];
    const base = computer(files, steps);
    const changed = {
      ...base,
      homeFiles: (paths: readonly string[], bytes: number) =>
        paths[0] === ".rea-build/b/a"
          ? Promise.resolve(new Map([[".rea-build/b/a", Buffer.from("SEED")]]))
          : base.homeFiles(paths, bytes),
    };
    await expect(
      fetchHomeFolder(changed, ".rea-build/b", {
        file: () => {
          steps.push("write");
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/differs from its listing/u);
    expect(steps).toEqual([]);
  });
});
