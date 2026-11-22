import { describe, expect, it } from "vitest";
import { computeBlockEntropy } from "../../domain/native/byteEntropy.js";
import {
  computePeOverlay,
  PE_OVERLAY_LIMITATIONS,
  PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS,
  PE_OVERLAY_MAX_REPORTED_SECTIONS,
  PE_OVERLAY_STRADDLING_SECURITY_LIMITATION,
  peOverlaySectionBudgetLimitation,
  type PeOverlay,
  type PeOverlaySectionInput,
} from "../../domain/native/peOverlay.js";
import { ParseFailureError } from "../../domain/parseFailure.js";
import { readPeImageHeaders } from "../../domain/pe/peImageHeaders.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import { peCertificateFixture } from "./PeCertificates.fixture.js";
import {
  peOverlayImage,
  SEVEN_ZIP_HEADER,
  ZIP_LOCAL_HEADER,
} from "./PeOverlay.fixture.js";
import { parsePeOverlay } from "./PeOverlayParser.js";

const artifactFor = (bytes: Buffer): PeOverlay["artifact"] => ({
  path: "/artifacts/app.exe",
  sha256: "ab".repeat(32),
  bytes: bytes.length,
});

const parse = (bytes: Buffer): PeOverlay =>
  parsePeOverlay(bytes, artifactFor(bytes));

const failureDetail = (bytes: Buffer): string => {
  try {
    parse(bytes);
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (cause instanceof ParseFailureError) return cause.failure.detail;
  }
  throw new Error("Expected a PE format failure");
};

describe("parsePeOverlay ranges", () => {
  it("reports an unsigned image with no overlay", () => {
    const bytes = peOverlayImage();
    const report = parse(bytes);
    expect(report).toMatchObject({
      format: "pe32",
      machine: 0x14c,
      size_of_headers: 0x200,
      image_end: bytes.length,
      file_size: bytes.length,
      present: false,
      ranges: [],
      limitations: [...PE_OVERLAY_LIMITATIONS],
    });
    expect(report.sections[0]).toMatchObject({
      index: 0,
      name: ".text",
      extends_image: true,
      raw_pointer_rounded: false,
    });
  });

  it("reports one zip range after an unsigned image", () => {
    const bytes = peOverlayImage({ trailing: ZIP_LOCAL_HEADER });
    const report = parse(bytes);
    expect(report.present).toBe(true);
    expect(report.image_end).toBe(0x400);
    expect(report.ranges).toEqual([
      {
        role: "other",
        offset: 0x400,
        size: ZIP_LOCAL_HEADER.length,
        sha256: sha256Hex(ZIP_LOCAL_HEADER),
        entropy: {
          window_bytes: 4096,
          sampled_bytes: ZIP_LOCAL_HEADER.length,
          shannon_bits: computeBlockEntropy(ZIP_LOCAL_HEADER),
        },
        prefix_hex: ZIP_LOCAL_HEADER.subarray(0, 16).toString("hex"),
        leading_format: "zip",
      },
    ]);
  });

  it("keeps a short prefix and samples only the fixed entropy window", () => {
    const tiny = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const tinyReport = parse(peOverlayImage({ trailing: tiny }));
    expect(tinyReport.ranges[0]).toMatchObject({
      role: "other",
      size: 4,
      prefix_hex: "01020304",
      entropy: { sampled_bytes: 4, shannon_bits: computeBlockEntropy(tiny) },
    });
    const trailing = Buffer.alloc(5000, 0);
    trailing.fill(0xff, 4096);
    const report = parse(peOverlayImage({ trailing }));
    const range = report.ranges[0];
    if (range?.role !== "other") throw new Error("Expected an other range");
    expect(range.entropy).toEqual({
      window_bytes: 4096,
      sampled_bytes: 4096,
      shannon_bits: 0,
    });
    expect(range.sha256).toBe(sha256Hex(trailing));
    expect(range.sha256).not.toBe(sha256Hex(trailing.subarray(0, 4096)));
  });

  it("splits a certificate table from bytes appended after it", () => {
    const signed = peCertificateFixture();
    const bytes = Buffer.concat([signed, ZIP_LOCAL_HEADER]);
    const report = parse(bytes);
    expect(report.image_end).toBe(0x200);
    expect(report.present).toBe(true);
    expect(
      report.ranges.map(({ role, offset, size }) => ({ role, offset, size })),
    ).toEqual([
      {
        role: "certificate_table",
        offset: 0x200,
        size: signed.length - 0x200,
      },
      {
        role: "other",
        offset: signed.length,
        size: ZIP_LOCAL_HEADER.length,
      },
    ]);
    expect(report.ranges[1]).toMatchObject({
      sha256: sha256Hex(ZIP_LOCAL_HEADER),
      leading_format: "zip",
    });
    expect(report.ranges[0]).not.toHaveProperty("sha256");
  });

  it("splits bytes before and after a certificate table in the overlay", () => {
    const trailing = Buffer.alloc(0x50, 0x11);
    const bytes = peOverlayImage({
      trailing,
      security: { offset: 0x420, size: 16 },
    });
    const report = parse(bytes);
    expect(
      report.ranges.map(({ role, offset, size }) => ({ role, offset, size })),
    ).toEqual([
      { role: "other", offset: 0x400, size: 0x20 },
      { role: "certificate_table", offset: 0x420, size: 16 },
      { role: "other", offset: 0x430, size: 0x20 },
    ]);
  });

  it("leaves a certificate table inside the image out of the overlay split", () => {
    const bytes = peOverlayImage({
      trailing: Buffer.alloc(0x100, 0x41),
      security: { offset: 0x280, size: 8 },
    });
    const report = parse(bytes);
    expect(report.ranges).toHaveLength(1);
    expect(report.ranges[0]).toMatchObject({
      role: "other",
      offset: 0x400,
      size: 0x100,
    });
    expect(report.limitations).toEqual([...PE_OVERLAY_LIMITATIONS]);
  });
});

describe("parsePeOverlay layout", () => {
  it("preserves the final section of a low-alignment image", () => {
    const bytes = peOverlayImage({
      sectionAlignment: 0x20,
      fileAlignment: 0x20,
      sections: [{ virtualAddress: 0x220, rawOffset: 0x220, rawSize: 0x20 }],
    });
    expect(parse(bytes)).toMatchObject({
      image_end: 0x240,
      file_size: 0x240,
      present: false,
      ranges: [],
      raw_pointer_rounding: { alignment: 1, direction: "down" },
      sections: [
        { rounded_pointer_to_raw_data: 0x220, raw_pointer_rounded: false },
      ],
    });
  });

  it.each([
    ["initialized data", 0xc0],
    ["code", 0xa0],
  ] as const)(
    "counts raw %s in a section also marked uninitialized",
    (_, characteristics) => {
      const bytes = peOverlayImage({
        fileSize: 0x400,
        sections: [{ rawOffset: 0x200, rawSize: 0x200, characteristics }],
      });
      expect(parse(bytes)).toMatchObject({
        sections: [{ extends_image: true }],
        image_end: bytes.length,
        present: false,
        ranges: [],
      });
    },
  );

  it("lists zero-size and uninitialized sections without extending the image", () => {
    const bytes = peOverlayImage({
      fileSize: 0x400,
      sections: [
        { name: ".text", rawOffset: 0x200, rawSize: 0x200 },
        {
          name: ".bss",
          rawOffset: 0x800,
          rawSize: 0x100,
          characteristics: 0xc0000080,
        },
        { name: ".empty", rawOffset: 0x9000, rawSize: 0, characteristics: 0 },
      ],
    });
    const report = parse(bytes);
    expect(report.present).toBe(false);
    expect(report.image_end).toBe(0x400);
    expect(report.sections.map((section) => section.extends_image)).toEqual([
      true,
      false,
      false,
    ]);
    expect(report.sections[1]).toMatchObject({
      name: ".bss",
      raw_pointer_rounded: false,
    });
  });

  it("names the section index when a raw range leaves the file", () => {
    const bytes = peOverlayImage({
      fileSize: 0x300,
      sections: [
        { name: ".text", rawOffset: 0x200, rawSize: 0x100 },
        { name: ".data", rawOffset: 0x400, rawSize: 0x100 },
      ],
    });
    expect(failureDetail(bytes)).toBe(
      "PE section index 1 raw range 1024 + 256 leaves the artifact.",
    );
    const first = peOverlayImage({
      fileSize: 0x200,
      sections: [{ name: ".text", rawOffset: 0x400, rawSize: 0x10 }],
    });
    expect(failureDetail(first)).toContain("section index 0");
  });

  it("leaves 7z unrecognized and reads a PE32+ image", () => {
    const bytes = peOverlayImage({ trailing: SEVEN_ZIP_HEADER });
    const report = parse(bytes);
    expect(report.ranges[0]).toMatchObject({
      role: "other",
      leading_format: "unrecognized",
      prefix_hex: SEVEN_ZIP_HEADER.subarray(0, 16).toString("hex"),
    });
    const plus = parse(peOverlayImage({ plus: true }));
    expect(plus).toMatchObject({
      format: "pe32-plus",
      machine: 0x8664,
      present: false,
      image_end: plus.file_size,
    });
  });
});

describe("parsePeOverlay security directory", () => {
  it.each([
    { name: "ends inside the overlay", size: 0x20 },
    { name: "ends at the file end", size: 0x110 },
  ])(
    "keeps the overlay of a security directory across the image end ($name)",
    ({ size }) => {
      const trailing = Buffer.alloc(0x100, 0x22);
      const report = parse(
        peOverlayImage({ trailing, security: { offset: 0x3f0, size } }),
      );
      expect(report).toMatchObject({
        image_end: 0x400,
        file_size: 0x500,
        present: true,
        security_directory: { status: "table", offset: 0x3f0, size },
      });
      expect(report.ranges).toEqual([
        expect.objectContaining({
          role: "other",
          offset: 0x400,
          size: 0x100,
          sha256: sha256Hex(trailing),
        }),
      ]);
      expect(report.limitations).toEqual([
        ...PE_OVERLAY_LIMITATIONS,
        PE_OVERLAY_STRADDLING_SECURITY_LIMITATION,
      ]);
    },
  );

  it("names only the directory defect when a malformed directory also crosses the image end", () => {
    const report = parse(
      peOverlayImage({
        trailing: Buffer.alloc(0x100),
        security: { offset: 0x3f4, size: 0x20 },
      }),
    );
    expect(report.ranges).toEqual([
      expect.objectContaining({ role: "other", offset: 0x400, size: 0x100 }),
    ]);
    expect(report.limitations).toEqual([
      ...PE_OVERLAY_LIMITATIONS,
      PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS.unaligned,
    ]);
  });

  it.each([
    {
      name: "unaligned inside the overlay",
      security: { offset: 0x404, size: 0x10 },
      defect: "unaligned",
    },
    {
      name: "leaving the file",
      security: { offset: 0x420, size: 0x100 },
      defect: "outside-artifact",
    },
    {
      name: "zero size",
      security: { offset: 0x400, size: 0 },
      defect: "empty-or-in-headers",
    },
  ] as const)(
    "measures overlay bytes behind a malformed security directory ($name)",
    ({ security, defect }) => {
      const trailing = Buffer.alloc(0x40, 0x11);
      const bytes = peOverlayImage({ trailing, security });
      const report = parse(bytes);
      expect(report.security_directory).toEqual({
        status: "malformed",
        ...security,
        defect,
      });
      expect(report.ranges).toEqual([
        expect.objectContaining({
          role: "other",
          offset: 0x400,
          size: 0x40,
          sha256: sha256Hex(trailing),
        }),
      ]);
      expect(report.limitations).toEqual([
        ...PE_OVERLAY_LIMITATIONS,
        PE_OVERLAY_MALFORMED_SECURITY_LIMITATIONS[defect],
      ]);
    },
  );
});

describe("parsePeOverlay section budget", () => {
  it("lists sections up to the row budget and still measures every section", () => {
    const declared = PE_OVERLAY_MAX_REPORTED_SECTIONS + 4;
    const sections = Array.from({ length: declared }, (_, index) => ({
      name: `.s${String(index)}`,
      rawOffset: 0x2000 + index * 0x200,
      rawSize: 0x200,
    }));
    const bytes = peOverlayImage({ sections, trailing: ZIP_LOCAL_HEADER });
    const report = parse(bytes);
    expect(report.sections).toHaveLength(PE_OVERLAY_MAX_REPORTED_SECTIONS);
    expect(report.sections.at(-1)?.index).toBe(
      PE_OVERLAY_MAX_REPORTED_SECTIONS - 1,
    );
    expect(report.section_coverage).toEqual({
      status: "partial",
      declared,
      reported: PE_OVERLAY_MAX_REPORTED_SECTIONS,
    });
    // The image end comes from the last, unlisted section.
    expect(report.image_end).toBe(0x2000 + declared * 0x200);
    expect(report.ranges).toEqual([
      expect.objectContaining({
        offset: report.image_end,
        size: ZIP_LOCAL_HEADER.length,
      }),
    ]);
    expect(report.limitations).toEqual([
      ...PE_OVERLAY_LIMITATIONS,
      peOverlaySectionBudgetLimitation(declared),
    ]);
    expect(parse(peOverlayImage()).section_coverage).toEqual({
      status: "complete",
      declared: 1,
      reported: 1,
    });
  });

  it("names an unlisted section index when its raw range leaves the file", () => {
    const declared = PE_OVERLAY_MAX_REPORTED_SECTIONS + 1;
    const sections = Array.from({ length: declared }, (_, index) => ({
      rawOffset: 0x2000,
      rawSize: index === declared - 1 ? 0x10_0000 : 0x200,
    }));
    expect(
      failureDetail(peOverlayImage({ sections, fileSize: 0x2200 })),
    ).toContain(`section index ${String(declared - 1)}`);
  });

  it("reports the largest declarable section table with only the row budget", () => {
    const declared = 0xffff;
    const sections = Array.from({ length: declared }, () => ({ rawSize: 0 }));
    const report = parse(peOverlayImage({ sections }));
    expect(report.sections).toHaveLength(PE_OVERLAY_MAX_REPORTED_SECTIONS);
    expect(report.section_coverage).toEqual({
      status: "partial",
      declared,
      reported: PE_OVERLAY_MAX_REPORTED_SECTIONS,
    });
  });

  it("counts and validates a one-shot section stream without collecting it", () => {
    const declared = 0xffff;
    let yielded = 0;
    function* stream(failingIndex?: number): Generator<PeOverlaySectionInput> {
      for (let index = 0; index < declared; index += 1) {
        yielded += 1;
        yield {
          index,
          name: "",
          pointerToRawData: 0x200,
          sizeOfRawData: index === failingIndex ? 0x10_0000 : 0x200,
          characteristics: 0x20,
        };
      }
    }
    const facts = (sections: Iterable<PeOverlaySectionInput>) => ({
      sizeOfHeaders: 0x200,
      sectionAlignment: 0x1000,
      fileAlignment: 0x200,
      sections,
    });
    const layout = computePeOverlay(facts(stream()), 0x400, undefined);
    expect(yielded).toBe(declared);
    expect(layout.sections).toHaveLength(PE_OVERLAY_MAX_REPORTED_SECTIONS);
    expect(layout.section_coverage).toEqual({
      status: "partial",
      declared,
      reported: PE_OVERLAY_MAX_REPORTED_SECTIONS,
    });

    // A bad section stops the stream where it sits, not after the whole table.
    const failingIndex = PE_OVERLAY_MAX_REPORTED_SECTIONS + 4;
    yielded = 0;
    expect(() =>
      computePeOverlay(facts(stream(failingIndex)), 0x400, undefined),
    ).toThrow(`section index ${String(failingIndex)}`);
    expect(yielded).toBe(failingIndex + 1);
  });
});

describe("parsePeOverlay raw extents", () => {
  it("records raw-pointer rounding without shortening the declared extent", () => {
    const bytes = peOverlayImage({
      sections: [{ name: ".text", rawOffset: 0x300, rawSize: 0x100 }],
      trailing: Buffer.alloc(0x20, 0x41),
    });
    const report = parse(bytes);
    expect(report.raw_pointer_rounding).toEqual({
      alignment: 512,
      direction: "down",
    });
    expect(report.sections[0]).toMatchObject({
      pointer_to_raw_data: 0x300,
      rounded_pointer_to_raw_data: 0x200,
      size_of_raw_data: 0x100,
      raw_pointer_rounded: true,
      extends_image: true,
    });
    expect(report.image_end).toBe(0x400);
    expect(report.file_size).toBe(0x420);
    expect(report.ranges).toEqual([
      expect.objectContaining({ role: "other", offset: 0x400, size: 0x20 }),
    ]);
  });

  it("keeps a noncanonical section's declared bytes out of the overlay", () => {
    const bytes = peOverlayImage({
      sectionAlignment: 0x200,
      fileAlignment: 0x200,
      sections: [{ name: ".text", rawOffset: 0x410, rawSize: 0x200 }],
    });
    expect(parse(bytes)).toMatchObject({
      image_end: 0x610,
      file_size: 0x610,
      present: false,
      ranges: [],
      sections: [
        { rounded_pointer_to_raw_data: 0x400, raw_pointer_rounded: true },
      ],
    });
  });

  it("takes alignment facts from the shared PE header reader", () => {
    const low = peOverlayImage({
      sectionAlignment: 0x20,
      fileAlignment: 0x20,
      sections: [{ virtualAddress: 0x220, rawOffset: 0x220, rawSize: 0x20 }],
    });
    expect(readPeImageHeaders(low)).toMatchObject({
      sectionAlignment: 0x20,
      fileAlignment: 0x20,
    });
    expect(parse(low).raw_pointer_rounding.alignment).toBe(1);
    const mismatched = peOverlayImage({
      sectionAlignment: 0x20,
      fileAlignment: 0x40,
      sections: [{ virtualAddress: 0x220, rawOffset: 0x220, rawSize: 0x20 }],
    });
    expect(readPeImageHeaders(mismatched)).toMatchObject({
      sectionAlignment: 0x20,
      fileAlignment: 0x40,
    });
    expect(parse(mismatched)).toMatchObject({
      raw_pointer_rounding: { alignment: 512, direction: "down" },
      image_end: 0x240,
      present: false,
    });
  });
});
