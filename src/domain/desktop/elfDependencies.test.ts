import { describe, expect, it } from "vitest";

import { desktopLibraryPolicy } from "./libraryPolicy.js";
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
    const image = elfImage({ needed: names });
    expect(await dependencies(image)).toMatchObject({
      ok: false,
      error: expect.stringContaining("library-policy.libraries=512"),
    });
    expect(
      await readElfDependencies(
        readImage(image),
        image.length,
        desktopLibraryPolicy({ libraries: 513 }),
      ),
    ).toMatchObject({ ok: true, value: { needed: names } });
  });

  it("distinguishes a bounded string read from truncation and recovers with its named budget", async () => {
    const needed = "l".repeat(4096);
    const image = elfImage({ needed: [needed] });
    expect(await dependencies(image)).toMatchObject({
      ok: false,
      error: expect.stringContaining("library-policy.string_bytes=4096 bytes"),
    });
    expect(
      await readElfDependencies(
        readImage(image),
        image.length,
        desktopLibraryPolicy({ string_bytes: 4097 }),
      ),
    ).toMatchObject({ ok: true, value: { needed: [needed] } });
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
