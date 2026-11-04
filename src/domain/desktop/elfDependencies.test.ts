import { describe, expect, it } from "vitest";

import { readElfDependencies } from "./elfDependencies.js";
import { elfImage, readImage } from "./elfImage.fixture.js";

const dependencies = (image: Buffer) =>
  readElfDependencies(readImage(image), image.length);

describe("readElfDependencies", () => {
  it("reads DT_NEEDED and the RPATH as Typora's executable declares them", async () => {
    const image = elfImage({
      rpath: "$ORIGIN",
      needed: [
        "libffmpeg.so",
        "libnss3.so",
        "libc.so.6",
        "ld-linux-aarch64.so.1",
      ],
    });

    expect(await dependencies(image)).toEqual({
      ok: true,
      value: {
        machine: 183,
        bits: 64,
        needed: [
          "libffmpeg.so",
          "libnss3.so",
          "libc.so.6",
          "ld-linux-aarch64.so.1",
        ],
        runpath: undefined,
        rpath: ["$ORIGIN"],
      },
    });
  });

  it("drops DT_RPATH when DT_RUNPATH is present, as ld.so does, and splits its directories", async () => {
    const image = elfImage({
      needed: ["libc.so.6"],
      rpath: "/opt/old",
      runpath: "$ORIGIN:$ORIGIN/../lib",
    });

    expect(await dependencies(image)).toMatchObject({
      ok: true,
      value: { runpath: ["$ORIGIN", "$ORIGIN/../lib"], rpath: [] },
    });
  });

  it("decodes each needed string once and refuses a table naming more libraries than the walk takes", async () => {
    const repeated = await dependencies(
      elfImage({ needed: ["libc.so.6"], repeatNeeded: 60_000 }),
    );
    expect(repeated).toMatchObject({
      ok: true,
      value: { needed: ["libc.so.6"] },
    });

    const names = Array.from(
      { length: 513 },
      (_, index) => `lib${String(index)}.so`,
    );
    expect(await dependencies(elfImage({ needed: names }))).toEqual({
      ok: false,
      error: "ELF dynamic table names more than 512 distinct needed libraries",
    });
  });

  it("reports no dependencies for a static image", async () => {
    expect(await dependencies(elfImage({ static: true }))).toMatchObject({
      ok: true,
      value: { needed: [], runpath: undefined, rpath: [] },
    });
  });

  it("refuses a script, a truncated image and a dynamic table without DT_NULL", async () => {
    const script = Buffer.from('#!/bin/sh\nexec /opt/app/app "$@"\n');
    expect(await dependencies(script)).toEqual({
      ok: false,
      error: "not an ELF image",
    });
    const image = elfImage({ needed: ["libc.so.6"] });
    expect(
      await readElfDependencies(readImage(image.subarray(0, 100)), 100),
    ).toMatchObject({ ok: false });
    expect(
      await dependencies(
        elfImage({ needed: ["libc.so.6"], unterminated: true }),
      ),
    ).toEqual({
      ok: false,
      error: "ELF dynamic table has no DT_NULL terminator",
    });
  });
});
