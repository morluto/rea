import { expect, it } from "vitest";
import {
  readPeImage,
  readPeImageFromReader,
} from "../../domain/native/peImage.js";
import { pe } from "../../domain/binaryTarget.fixture.js";
import { parseMzHeaderEvidence } from "../../domain/dosMz.js";
import { BinaryFormatFailure } from "../../domain/binaryContainer.js";
import { readBinaryContainer } from "../../domain/native/readBinaryContainer.js";
import {
  readGoFixture,
  GO_MODULE_TEXT,
  createGoBinaryFixture,
  setGoPeVirtualSize,
} from "../../../tests/fixtures/go/image.js";
import { bufferByteSource } from "../../domain/byteSource.js";

for (const bits of [32, 64] as const) {
  it.each([
    ["ZZ", Buffer.from("ZZ")],
    ["high-bit MZ", Buffer.from([0xcd, 0xda])],
  ] as const)(
    `rejects %s before reading PE${String(bits)} facts`,
    (_, prefix) => {
      const { bytes } = createGoBinaryFixture({ format: "pe", bits });
      prefix.copy(bytes);
      const declarations = parseMzHeaderEvidence(bytes).declarations;
      if (declarations.ok) throw new Error("Expected invalid MZ declarations");
      expect(() => readPeImage(bytes)).toThrow(
        expect.objectContaining({
          kind: "malformed",
          message: declarations.error,
        }),
      );
    },
  );

  it(`reads PE${String(bits)} without requiring a valid DOS load module`, () => {
    const { bytes } = createGoBinaryFixture({ format: "pe", bits });
    bytes.writeUInt16LE(0, 4);
    expect(parseMzHeaderEvidence(bytes).dos.ok).toBe(false);
    expect(readPeImage(bytes)).toMatchObject({ format: "pe", bits });
  });
}

it("classifies a confirmed overlapping PE as an unsupported layout", () => {
  try {
    readPeImage(pe(0x014c, 4));
    throw new Error("Expected an unsupported PE layout");
  } catch (cause) {
    expect(cause).toBeInstanceOf(BinaryFormatFailure);
    expect(cause).toMatchObject({ kind: "unsupported" });
    expect((cause as Error).message).toContain("overlapping PE header");
  }
});

it("reports complete DOS MZ images as outside the PE reader", () => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt16LE(128, 2);
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(2, 6);
  bytes.writeUInt16LE(4, 8);
  bytes.writeUInt16LE(28, 24);
  bytes.write("ABCD", 60, "ascii");
  expect(() => readPeImage(bytes)).toThrow(
    "DOS MZ images are outside the supported ELF, PE and thin Mach-O formats",
  );
});

it.each(["NE", "LE", "LX"])(
  "recognizes %s without requiring a PE COFF header",
  (signature) => {
    const bytes = pe(0x014c).subarray(0, 66);
    bytes.write(signature, 64, "ascii");
    expect(() => readBinaryContainer(bytes, "elf-directory")).toThrow(
      expect.objectContaining({
        kind: "unsupported",
        message: expect.stringContaining(signature),
      }),
    );
  },
);

it.each([32, 64] as const)(
  "uses raw-size fallback for PE%d Go build-info and keeps RVA mappings intact",
  async (bits) => {
    for (const encoding of ["inline", "pointer"] as const) {
      const fixture = createGoBinaryFixture({ format: "pe", bits, encoding });
      setGoPeVirtualSize(fixture.bytes, 0);

      const container = await readPeImageFromReader(
        bufferByteSource(fixture.bytes, 4096),
      );
      expect(container.sections[0]).toMatchObject({
        name: ".data",
        offset: 1024,
        size: 2048,
        file_backed: true,
        virtual_address: 0x400,
        virtual_size: 0,
        raw_size: 2048,
        characteristics: 0xc0000040,
      });
      expect(container.mappings[0]).toMatchObject({
        address: 0x10400n,
        offset: 1024,
        size: 2048,
      });
      expect(container.image_base).toBe(0x10000n);
      expect(container.executable_mappings).toEqual([]);
      expect((await readGoFixture(fixture.bytes)).build_info).toMatchObject({
        go_version: "go1.26.0",
        encoding,
        header_offset: fixture.headerOffset,
        module_text: GO_MODULE_TEXT,
        module: {
          path: "example.com/tool/cmd/tool",
          main: { path: "example.com/tool", version: "(devel)" },
          dependencies: [
            {
              path: "example.com/dependency",
              version: "v1.2.3",
              replacement: { path: "../dependency" },
            },
          ],
        },
        go_version_bytes_base64: Buffer.from("go1.26.0").toString("base64"),
        module_bytes_base64: fixture.moduleBytes.toString("base64"),
        version_location: { offset: fixture.versionOffset, bytes: 8 },
        module_location: {
          offset: fixture.moduleOffset,
          bytes: fixture.moduleBytes.length,
        },
      });
    }
  },
);

it.each([32, 64] as const)(
  "retains PE%d declared image base and alignments in native image facts",
  (bits) => {
    const { bytes } = createGoBinaryFixture({ format: "pe", bits });
    const optional = bytes.readUInt32LE(0x3c) + 24;
    const imageBase = bits === 64 ? 0xfedcba9876540000n : 0x87650000n;
    if (bits === 64) bytes.writeBigUInt64LE(imageBase, optional + 24);
    else bytes.writeUInt32LE(Number(imageBase), optional + 28);
    // These remain declarations; alignment policy belongs to image consumers.
    bytes.writeUInt32LE(0, optional + 32);
    bytes.writeUInt32LE(0xffffffff, optional + 36);
    const container = readPeImage(bytes);
    expect(container.image_base).toBe(imageBase);
    expect(container.pe_header_mapping.address).toBe(imageBase);
    expect(container.mappings[0]?.address).toBe(imageBase + 0x400n);
    expect(container.pe_section_alignment).toBe(0);
    expect(container.pe_file_alignment).toBe(0xffffffff);
    expect(container.sections[0]?.file_alignment).toBe(0xffffffff);
  },
);

it("keeps Go fallback candidates when a PE section has no printable name", async () => {
  const fixture = createGoBinaryFixture({ format: "pe", bits: 64 });
  const expected = (await readGoFixture(fixture.bytes)).build_info;
  expect(expected).toMatchObject({ go_version: "go1.26.0" });
  const pe = fixture.bytes.readUInt32LE(0x3c);
  const section = pe + 24 + fixture.bytes.readUInt16LE(pe + 20);
  fixture.bytes.fill(0, section, section + 8);

  const container = readPeImage(fixture.bytes);
  expect(container.sections[0]).toMatchObject({
    name: "",
    characteristics: 0xc0000040,
  });
  expect((await readGoFixture(fixture.bytes)).build_info).toEqual(expected);
});

it.each(["inline", "pointer"] as const)(
  "does not search PE raw alignment padding beyond a nonzero VirtualSize (%s)",
  async (encoding) => {
    const fixture = createGoBinaryFixture({ format: "pe", bits: 64, encoding });
    // Put an otherwise valid, aligned record in the raw-only tail.
    fixture.bytes.copy(
      fixture.bytes,
      fixture.headerOffset + 512,
      fixture.headerOffset,
      fixture.headerOffset + 512,
    );
    fixture.bytes.fill(0, fixture.headerOffset, fixture.headerOffset + 512);
    setGoPeVirtualSize(fixture.bytes, 512);

    const container = readPeImage(fixture.bytes);
    expect(container.sections[0]).toMatchObject({
      size: 512,
      file_backed: true,
    });
    expect(container.mappings[0]).toMatchObject({ size: 2048, offset: 1024 });
    expect(container.sections[0]).toMatchObject({
      size: 512,
      offset: 1024,
      virtual_size: 512,
      raw_size: 2048,
    });
    expect(container).not.toHaveProperty("data_ranges");
    expect((await readGoFixture(fixture.bytes)).build_info).toBeNull();
  },
);

it.each([
  [0x014c, 0x7b79, "386", 32],
  [0x8664, 0x7b79, "amd64", 64],
  [0x01c0, 0x4644, "arm", 32],
  [0xaa64, 0x4644, "arm64", 64],
] as const)(
  "shares managed PE machine identity for %s with override %s",
  (machine, override, architecture, bits) => {
    const bytes = pe(machine, 64, 0x2002, true);
    bytes.writeUInt16LE(machine ^ override, 68);
    expect(readPeImage(bytes)).toMatchObject({
      pe_machine: machine ^ override,
      architecture,
      bits,
    });
  },
);

it.each([0x014c, 0x8664] as const)(
  "rejects a contradictory optional-header width for COFF machine %s",
  (machine) => {
    const bytes = pe(machine);
    bytes.writeUInt16LE(machine === 0x014c ? 0x20b : 0x10b, 88);
    expect(() => readPeImage(bytes)).toThrow(
      "PE optional-header magic does not match its architecture",
    );
  },
);

it("reads DllCharacteristics from the optional header", () => {
  const bytes = pe(0x8664);
  const peOffset = bytes.readUInt32LE(60);
  bytes.writeUInt16LE(0x4160, peOffset + 24 + 70);
  expect(readPeImage(bytes)).toMatchObject({
    dll_characteristics: 0x4160,
    pe_optional_header_file_offset: peOffset + 24,
    dll_characteristics_file_offset: peOffset + 24 + 70,
  });
});

it.each([0xffff, 0x8664 ^ 0x7b79])(
  "retains raw unknown machine %s without managed override proof",
  (machine) => {
    const bytes = pe(0x8664);
    bytes.writeUInt16LE(machine, 68);
    expect(readPeImage(bytes)).toMatchObject({
      pe_machine: machine,
      architecture: `pe-machine-${machine}`,
      bits: 64,
    });
  },
);

it.each([0x014c, 0x8664])(
  "admits a streamed empty section table at EOF for machine %s",
  async (machine) => {
    const bytes = pe(machine);
    const peOffset = bytes.readUInt32LE(60);
    const image = bytes.subarray(
      0,
      peOffset + 24 + bytes.readUInt16LE(peOffset + 20),
    );
    const reads: number[] = [];
    const streamed = await readPeImageFromReader({
      size: image.length,
      prefix: image.subarray(0, 64),
      readRange: async (offset, length) => {
        reads.push(length);
        return image.subarray(offset, offset + length);
      },
    });
    expect(streamed).toEqual(readPeImage(image));
    expect(streamed.sections).toEqual([]);
    expect(reads.every((length) => length > 0)).toBe(true);
  },
);

/** PE32 header-only image with SizeOfHeaders covering its headers. */
const headerOnlyPe = (): Buffer => {
  const bytes = pe(0x014c);
  bytes.writeUInt32LE(512, 64 + 24 + 60);
  return bytes;
};
const anomalyCodes = (bytes: Buffer) =>
  readPeImage(bytes).pe_header_anomalies.map(({ code }) => code);

it("reads consistent headers without header anomalies", () => {
  expect(readPeImage(headerOnlyPe())).toMatchObject({
    pe_size_of_headers: 512,
    pe_header_anomalies: [],
  });
});

it.each([0, 96, 144])(
  "reads fixed fields and directories at their offsets when SizeOfOptionalHeader is %i",
  async (optionalSize) => {
    // corkami mini.exe (0) and ddsect.exe (144): the loader reads the
    // optional header at fixed offsets; the size only locates sections.
    const bytes = headerOnlyPe();
    bytes.writeUInt32LE(0x3000, 64 + 24 + 96 + 8);
    bytes.writeUInt32LE(0x28, 64 + 24 + 96 + 12);
    bytes.writeUInt16LE(optionalSize, 64 + 20);
    const image = readPeImage(bytes);
    expect(image.pe_data_directories[1]).toEqual({
      address: 0x3000,
      size: 0x28,
      offset: 104,
    });
    expect(image.pe_header_anomalies).toEqual([
      {
        code: "optional_header_size_below_fields",
        message: expect.stringContaining(
          `SizeOfOptionalHeader ${String(optionalSize)}`,
        ),
      },
    ]);
    await expect(
      readPeImageFromReader({
        size: bytes.length,
        prefix: bytes.subarray(0, 64),
        readRange: async (offset, length) =>
          bytes.subarray(offset, offset + length),
      }),
    ).resolves.toEqual(image);
  },
);

it("reads only the 16 directories the loader reads when NumberOfRvaAndSizes is larger", () => {
  // corkami maxvals.exe declares 0xffffffff.
  const bytes = headerOnlyPe();
  bytes.writeUInt32LE(0xffffffff, 64 + 24 + 92);
  const image = readPeImage(bytes);
  expect(image.pe_data_directories).toHaveLength(16);
  expect(anomalyCodes(bytes)).toEqual(["directory_count_above_maximum"]);
});

it.each([
  ["before the section table end", 44],
  ["past the file end", 0x10000],
])("records SizeOfHeaders %s instead of refusing", (_, sizeOfHeaders) => {
  // corkami foldedhdr.exe (44) and maxsec_lowaligW7.exe layouts.
  const bytes = headerOnlyPe();
  bytes.writeUInt32LE(sizeOfHeaders, 64 + 24 + 60);
  expect(readPeImage(bytes)).toMatchObject({
    pe_size_of_headers: sizeOfHeaders,
    pe_header_mapping: { size: Math.min(sizeOfHeaders, bytes.length) },
  });
  expect(anomalyCodes(bytes)).toEqual(["size_of_headers_inconsistent"]);
});

it("refuses mapped section bytes past the file but admits them for header-only readers", () => {
  const bytes = headerOnlyPe();
  bytes.writeUInt16LE(1, 64 + 6);
  const section = 64 + 24 + 224;
  bytes.writeUInt32LE(0x1000, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x1000, section + 16);
  bytes.writeUInt32LE(bytes.length, section + 20);
  expect(() => readPeImage(bytes)).toThrow(
    expect.objectContaining({ kind: "truncated" }),
  );
  expect(readPeImage(bytes, "headers")).toMatchObject({
    mappings: [],
    sections: [{ raw_size: 0x1000, file_backed: false }],
  });
});

it("keeps an unrecognized Windows signature malformed when the DOS module is invalid", () => {
  // pe() declares no DOS pages, so the bytes are neither a DOS module nor a
  // PE image once e_lfanew points at "PX".
  const bytes = headerOnlyPe();
  bytes.write("PX\0\0", 64, "latin1");
  expect(() => readPeImage(bytes)).toThrow(
    expect.objectContaining({ kind: "malformed" }),
  );
});
