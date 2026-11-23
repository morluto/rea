import { expect, it } from "vitest";
import {
  createGoCrossLoadPointerFixture,
  createGoPeHeaderPointerFixture,
  GO_MODULE_TEXT,
} from "../../tests/fixtures/go/image.js";
import { readGoBinaryImage } from "./GoBinaryImage.js";

const cases = [
  ...([32, 64] as const).flatMap((bits) =>
    (["contents", "descriptors"] as const).map((placement) => ({
      image: `PE${bits} headers`,
      bits,
      format: "pe",
      placement,
      create: () => createGoPeHeaderPointerFixture(bits, placement),
    })),
  ),
  ...(["contents", "descriptor"] as const).map((placement) => ({
    image: "adjacent ELF loads",
    bits: 64,
    format: "elf",
    placement,
    create: () => createGoCrossLoadPointerFixture(placement),
  })),
];

it.each(cases)(
  "retains pointer $placement in $image with exact source ranges",
  ({ create, bits, format }) => {
    const fixture = create();
    expect(readGoBinaryImage(fixture.bytes)).toMatchObject({
      format,
      bits,
      build_info: {
        encoding: "pointer",
        go_version: "go1.26.0",
        go_version_bytes_base64: Buffer.from("go1.26.0").toString("base64"),
        module_text: GO_MODULE_TEXT,
        module_bytes_base64: fixture.moduleBytes.toString("base64"),
        version_location: { offset: fixture.versionOffset, bytes: 8 },
        module_location: {
          offset: fixture.moduleOffset,
          bytes: fixture.moduleBytes.length,
        },
      },
    });
  },
);
