import { expect, it } from "vitest";
import { readMachoImage } from "../../domain/apple/machoLoadCommandReader.js";
import {
  machoImageWithLazyLoadDylibInfo,
  readerOf,
} from "./MachoImage.fixture.js";

it("resolves lazy dylib fields in an unaligned Uint8Array view", async () => {
  const name = "@rpath/libExample.dylib";
  const image = machoImageWithLazyLoadDylibInfo({
    path: name,
    symbols: ["_one", "_two"],
    flags: 1,
  });
  const backing = new Uint8Array(image.length + 12).fill(0xff);
  backing.set(image, 5);
  const slice = backing.subarray(5, 5 + image.length);
  const facts = await readMachoImage(readerOf(slice), slice.length);
  expect(facts).toMatchObject({
    status: "parsed",
    slices: [
      {
        dependencies: [
          {
            command: "LC_LAZY_LOAD_DYLIB_INFO",
            install_name: name,
            weak: true,
          },
        ],
      },
    ],
  });
  const short = slice.subarray(0, -1);
  expect(await readMachoImage(readerOf(short), short.length)).toMatchObject({
    status: "failed",
    failure: { kind: "malformed" },
  });
});
