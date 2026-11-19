import { Buffer } from "node:buffer";
import { expect, it } from "vitest";

import {
  buildSection,
  buildGuidedSection,
  buildLzmaGuidedSection,
} from "../../tests/fixtures/uefiImage.js";
import { imageRegion } from "./UefiBytes.js";
import {
  AMD_ZLIB_HEADER_LENGTH,
  peelAmiZlibPayload,
  walkSections,
} from "./FfsSections.js";

it("walks a two-section chain with clean payload windows", () => {
  const ui = buildSection(0x15, Buffer.from("Module"));
  const pe = buildSection(0x10, Buffer.from([0x4d, 0x5a, 0x90]));
  const chain = Buffer.concat([ui, pe]);
  const region = imageRegion(chain, 0, chain.length);
  const walked = walkSections(region);
  expect(walked.remainder).toBeNull();
  expect(walked.sections).toHaveLength(2);
  const [uiDraft, peDraft] = walked.sections;
  expect(uiDraft?.typeCode).toBe(0x15);
  expect(uiDraft?.headerLength).toBe(4);
  expect(uiDraft?.payload).toEqual({ start: 4, end: 4 + 6 });
  // The PE section starts after the first section's 4-byte chain alignment.
  expect(peDraft?.payload).toEqual({ start: 16, end: 19 });
  expect(peDraft?.typeCode).toBe(0x10);
});

it("classifies a guided LZMA section through its definition GUID", () => {
  const compressed = Buffer.from([
    0x5d, 0x00, 0x00, 0x08, 0x00, 0x01, 0x02, 0x03,
  ]);
  const section = buildLzmaGuidedSection(compressed);
  const region = imageRegion(section, 0, section.length);
  const walked = walkSections(region);
  const draft = walked.sections[0];
  expect(draft?.compression).toMatchObject({
    kind: "lzma-custom",
    guid: "ee4e5898-3914-4259-9d6e-dc7bd79403cf",
    dataOffset: 24,
    attributes: 0,
  });
  expect(draft?.payload).toEqual({ start: 24, end: 24 + compressed.length });
});

it("classifies the AMI-zlib guided section and peels its AMD header", () => {
  const stream = Buffer.from([0x78, 0xda, 0x01, 0x02, 0x03]);
  const amdHeader = Buffer.alloc(AMD_ZLIB_HEADER_LENGTH, 0);
  amdHeader.writeUInt32LE(stream.length, 0x14);
  const section = buildGuidedSection({
    definitionGuid: "ce3233f5-2cd6-4d87-9152-4a238bb6d1c4",
    body: Buffer.concat([amdHeader, stream]),
  });
  const region = imageRegion(section, 0, section.length);
  const walked = walkSections(region);
  expect(walked.sections).toHaveLength(1);
  const draft = walked.sections[0];
  expect(draft?.compression).toMatchObject({
    kind: "ami-zlib",
    guid: "ce3233f5-2cd6-4d87-9152-4a238bb6d1c4",
    dataOffset: 24,
    attributes: 0,
  });
  expect(draft?.payload).toEqual({
    start: 24,
    end: 24 + AMD_ZLIB_HEADER_LENGTH + stream.length,
  });
  const peeled = peelAmiZlibPayload(Buffer.concat([amdHeader, stream]));
  expect(peeled).toEqual({ stream, declaredCompressedSize: stream.length });
  expect(peelAmiZlibPayload(Buffer.alloc(0x40, 0))).toBeNull();
});

it("marks unknown definition GUIDs instead of guessing", () => {
  const raw = Buffer.alloc(12, 0xab);
  const section = buildGuidedSection({
    definitionGuid: "99999999-8888-7777-6666-555555555555",
    body: raw,
  });
  const region = imageRegion(section, 0, section.length);
  const draft = walkSections(region).sections[0];
  if (draft?.compression.kind !== "unknown-guid") {
    throw new Error(
      `expected unknown-guid, got ${draft?.compression.kind ?? "none"}`,
    );
  }
  expect(draft.compression.attributes).toBe(0);
  expect(draft?.payload).toEqual({ start: 24, end: 24 + 12 });
});

it("records a truncated final section instead of inventing one", () => {
  const ui = buildSection(0x15, Buffer.from("Module"));
  const truncatedBody = Buffer.alloc(10, 0x77);
  truncatedBody.writeUInt32LE(0xfff, 0); // declared far beyond the region
  const truncated = Buffer.concat([
    Buffer.from([0xff, 0x0f, 0x00, 0x10]), // declared length 0xfff at size field
    truncatedBody,
  ]);
  const chain = Buffer.concat([ui, truncated]);
  const region = imageRegion(chain, 0, chain.length);
  const walked = walkSections(region);
  expect(walked.sections).toHaveLength(2);
  const last = walked.sections[1];
  expect(last?.typeCode).toBe(0x10);
  expect(last?.truncated).toBe(true);
});

it("returns no sections when the area is shorter than one header", () => {
  const region = imageRegion(Buffer.from([2, 0, 0]), 0, 3);
  expect(walkSections(region).sections).toHaveLength(0);
});

it("uses the extended common header for both guided and standard compression fields", () => {
  const guided = Buffer.from(
    "ffffff020000000198584eee143959429d6edc7bd79403cf1c00010001020304",
    "hex",
  );
  const standard = Buffer.from("ffffff01000000010a0000000101020304", "hex");
  for (const [section, expected] of [
    [guided, { kind: "lzma-custom", dataOffset: 28, attributes: 1 }],
    [standard, { kind: "efi-standard", dataOffset: 13, attributes: null }],
  ] as const) {
    const record = walkSections(imageRegion(section, 0, section.length))
      .sections[0];
    expect(record).toMatchObject({ truncated: true, malformed: false });
    expect(record?.compression).toMatchObject(expected);
    expect(record?.payload).toEqual({
      start: expected.dataOffset,
      end: section.length,
    });
  }
});

it("reports an undersized extended header and preserves its bounded sibling", () => {
  const oversizedHeader = Buffer.from("ffffff190c00000001020304", "hex");
  const peer = buildSection(0x19, Buffer.from([0x41]));
  const chain = Buffer.concat([oversizedHeader, peer]);
  expect(
    walkSections(imageRegion(chain, 0, chain.length)).sections,
  ).toMatchObject([
    {
      malformed: true,
      payload: null,
      extendedHeaderIssue: expect.stringContaining("compact PI header"),
    },
    { malformed: false, absoluteBase: 12, payload: { start: 16, end: 17 } },
  ]);
});

it("retains a truncated extended frame but marks its placement in a compact FFS file invalid", () => {
  const section = Buffer.from("ffffff1900000001", "hex");
  const region = imageRegion(section, 0, section.length);
  expect(walkSections(region, () => true, false).sections).toMatchObject([
    {
      malformed: true,
      truncated: true,
      extendedHeaderIssue: expect.stringContaining("requires a large FFS file"),
    },
  ]);
});

it.each([
  { offset: 20, malformed: true },
  { offset: 30, malformed: false },
  { offset: 44, malformed: true },
])(
  "preserves guided metadata when DataOffset $offset cannot be read",
  ({ offset, malformed }) => {
    const section = buildLzmaGuidedSection(Buffer.from([0x11, 0x22]));
    section.writeUIntLE(40, 0, 3);
    section.writeUInt16LE(offset, 20);
    section.writeUInt16LE(1, 22);
    const record = walkSections(imageRegion(section, 0, section.length))
      .sections[0];
    expect(record).toMatchObject({
      truncated: true,
      malformed,
      payload: null,
      compression: {
        kind: "lzma-custom",
        guid: "ee4e5898-3914-4259-9d6e-dc7bd79403cf",
        dataOffset: offset,
        attributes: 1,
      },
    });
  },
);

it.each([0x01, 0x02, 0x14, 0x18])(
  "distinguishes a truncated fixed header from a short declaration for type %i",
  (typeCode) => {
    const section = Buffer.from([40, 0, 0, typeCode, 0]);
    const region = imageRegion(section, 0, section.length);
    expect(walkSections(region).sections[0]).toMatchObject({
      truncated: true,
      malformed: false,
      payload: null,
    });
    section.writeUIntLE(section.length, 0, 3);
    expect(walkSections(region).sections[0]).toMatchObject({
      truncated: false,
      malformed: true,
      payload: null,
    });
  },
);

it("does not treat a CRC32-defined section with a missing checksum field as a child stream", () => {
  const crc32Guid = "fc1bcdb0-7d31-49aa-936a-a4600d9dd083";
  const body = buildSection(0x19, Buffer.from([0x61]));
  const missingCrc = buildGuidedSection({
    definitionGuid: crc32Guid,
    body,
    dataOffset: 24,
  });
  expect(
    walkSections(imageRegion(missingCrc, 0, missingCrc.length)).sections[0],
  ).toMatchObject({
    malformed: true,
    payload: null,
    compression: { kind: "crc32-guided", dataOffset: 24 },
  });

  const withCrc = buildGuidedSection({
    definitionGuid: crc32Guid,
    body,
    dataOffset: 28,
  });
  expect(
    walkSections(imageRegion(withCrc, 0, withCrc.length)).sections[0],
  ).toMatchObject({
    malformed: false,
    payload: { start: 28, end: 36 },
    content: { kind: "stored-sections", guidedIntegrityUnchecked: true },
  });
});

it.each([
  "a7717414-c616-4977-9420-844712a735bf",
  "3d532050-5cda-4fd0-879e-0f7f630d5afb",
  "1d301fe9-be79-4353-91c2-d23bc959ae0c",
])(
  "keeps known opaque guided wrappers with GUID %s out of child traversal",
  (definitionGuid) => {
    const body = buildSection(0x19, Buffer.from([0x61]));
    const opaque = buildGuidedSection({ definitionGuid, body, attributes: 0 });
    expect(
      walkSections(imageRegion(opaque, 0, opaque.length)).sections[0],
    ).toMatchObject({
      compression: { kind: "unknown-guid", guid: definitionGuid },
      content: { kind: "unsupported", gap: "unknown-guid-handler" },
    });
  },
);

it("reports an incomplete extended header separately from its preceding record budget", () => {
  const section = buildSection(0x19, Buffer.alloc(0));
  const body = Buffer.concat([section, Buffer.from([0xff, 0xff, 0xff, 0x19])]);
  let slots = 1;
  const walked = walkSections(
    imageRegion(body, 0, body.length),
    () => slots-- > 0,
  );
  expect(walked.sections).toHaveLength(1);
  expect(walked.remainder).toEqual({ kind: "unparsed", start: 4 });
});
