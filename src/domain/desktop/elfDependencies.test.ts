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
        searchPaths: ["$ORIGIN"],
      },
    });
  });

  it("prefers DT_RUNPATH over DT_RPATH and splits its directories", async () => {
    const image = elfImage({
      needed: ["libc.so.6"],
      rpath: "/opt/old",
      runpath: "$ORIGIN:$ORIGIN/../lib",
    });

    expect(await dependencies(image)).toMatchObject({
      ok: true,
      value: { searchPaths: ["$ORIGIN", "$ORIGIN/../lib"] },
    });
  });

  it("reports no dependencies for a static image", async () => {
    expect(await dependencies(elfImage({ static: true }))).toMatchObject({
      ok: true,
      value: { needed: [], searchPaths: [] },
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
