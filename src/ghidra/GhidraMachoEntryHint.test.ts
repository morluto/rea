import { open, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  CPU,
  FILE_TYPE,
  fatImage,
  machoImage,
} from "../artifacts/apple/MachoImage.fixture.js";
import { elf } from "../domain/binaryTarget.fixture.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import {
  mainCommand,
  mappedSegment,
  strippedMachoWithMain,
  TEXT_SEGMENT,
} from "./GhidraMachoEntryHint.fixture.js";
import {
  ghidraMachoMainEntryHint,
  isGhidraMainSelector,
  type GhidraSnapshotRangeReader,
} from "./GhidraMachoEntryHint.js";

const HINT =
  "This Mach-O declares its entry point with LC_MAIN at file offset 0x460, analysis address 0x100000460; stripped binaries often have no main symbol, and Ghidra often names that function entry. Request 0x100000460 explicitly to read it.";

/** In-memory reader that records each requested range. */
const recordingReader = (bytes: Uint8Array) => {
  const reads: { readonly position: number; readonly length: number }[] = [];
  const read: GhidraSnapshotRangeReader = (position, length) => {
    reads.push({ position, length });
    return Promise.resolve(bytes.subarray(position, position + length));
  };
  return { read, reads };
};

const hintFor = (bytes: Uint8Array) =>
  ghidraMachoMainEntryHint(recordingReader(bytes).read, bytes.byteLength);

describe("isGhidraMainSelector", () => {
  it.each(["main", "_main", "MAIN", "_Main", "  main\t"])(
    "accepts %j",
    (selector) => {
      expect(isGhidraMainSelector(selector)).toBe(true);
    },
  );
  it.each(["foo", "mainly", "__main", "main_", "0x100000460", "", 1, null])(
    "rejects %j",
    (selector) => {
      expect(isGhidraMainSelector(selector)).toBe(false);
    },
  );
});

describe("ghidraMachoMainEntryHint", () => {
  it("names the LC_MAIN entry after reading only the header and load commands", async () => {
    const image = strippedMachoWithMain();
    const commandsEnd = 32 + new DataView(image.buffer).getUint32(20, true);
    const { read, reads } = recordingReader(image);
    await expect(
      ghidraMachoMainEntryHint(read, image.byteLength),
    ).resolves.toBe(HINT);
    expect(reads).toEqual([
      { position: 0, length: 32 },
      { position: 0, length: commandsEnd },
    ]);
  });

  it("maps the entry through the segment whose file range contains it", async () => {
    const image = machoImage({
      commands: [
        TEXT_SEGMENT,
        mappedSegment({
          name: "__CODE",
          vmaddr: 0x200000000n,
          fileoff: 0x4000n,
          filesize: 0x1000n,
        }),
        mainCommand(0x4010n),
      ],
    });
    await expect(hintFor(image)).resolves.toContain(
      "file offset 0x4010, analysis address 0x200000010;",
    );
  });

  it("gives no hint for a FAT container", async () => {
    const fat = fatImage([{ cpu: CPU.arm64, bytes: strippedMachoWithMain() }]);
    const { read, reads } = recordingReader(fat);
    await expect(
      ghidraMachoMainEntryHint(read, fat.byteLength),
    ).resolves.toBeUndefined();
    expect(reads).toEqual([{ position: 0, length: 32 }]);
  });

  it("still names the entry of a target larger than 128 MiB", async () => {
    const root = await createTestTempDirectory("rea-macho-entry-hint-");
    const path = join(root, "large-stripped");
    await writeFile(path, strippedMachoWithMain());
    const size = 160 * 1024 * 1024;
    await truncate(path, size);
    const handle = await open(path, "r");
    onTestFinished(() => handle.close());
    let bytesRead = 0;
    const read: GhidraSnapshotRangeReader = async (position, length) => {
      const bytes = await readFileHandleRange(handle, position, length);
      bytesRead += bytes.byteLength;
      return bytes;
    };
    expect((await handle.stat()).size).toBe(size);
    await expect(ghidraMachoMainEntryHint(read, size)).resolves.toBe(HINT);
    expect(bytesRead).toBeLessThan(1024);
  });

  it.each([
    {
      name: "a dylib without LC_MAIN",
      image: machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [TEXT_SEGMENT],
      }),
    },
    {
      name: "an executable without LC_MAIN",
      image: machoImage({ commands: [TEXT_SEGMENT] }),
    },
    {
      name: "a non-executable that declares LC_MAIN",
      image: machoImage({
        fileType: FILE_TYPE.bundle,
        commands: [TEXT_SEGMENT, mainCommand(0x460n)],
      }),
    },
    {
      name: "an entry outside every mapped file range",
      image: machoImage({ commands: [TEXT_SEGMENT, mainCommand(0x8000n)] }),
    },
    {
      name: "two LC_MAIN commands",
      image: machoImage({
        commands: [TEXT_SEGMENT, mainCommand(0x460n), mainCommand(0x480n)],
      }),
    },
    { name: "an ELF image", image: elf(2, 1, 0xb7) },
    { name: "an empty file", image: new Uint8Array(0) },
    {
      name: "a file shorter than a Mach-O header",
      image: strippedMachoWithMain().subarray(0, 20),
    },
    {
      name: "load commands cut short by the end of the file",
      image: strippedMachoWithMain().subarray(0, 64),
    },
  ])("returns no hint for $name", async ({ image }) => {
    await expect(hintFor(image)).resolves.toBeUndefined();
  });
});
