import { crc32 } from "node:zlib";
import { expect, it } from "vitest";

import {
  ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
  ELF_DEBUG_LINK_MULTIPLE_BUILD_IDS_LIMITATION,
  ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION,
  elfDebugLinkSchema,
  inspectElfDebugLinkInputSchema,
} from "../../domain/native/elfDebugLink.js";
import { elfNote, gnuBuildIdNote } from "./ElfNotes.fixture.js";
import { readElfImage } from "../../domain/native/elfImage.js";
import {
  parseElfDebugLinkFromHandle,
  verifyElfDebugCandidate,
} from "./ElfDebugLink.js";
import {
  debugaltlinkSection,
  debuglinkSection,
  elfDebugCandidateFixture,
  elfDebugLinkByteSource,
  elfDebugLinkFixture,
  FIXTURE_BUILD_ID_HEX,
  FIXTURE_DEBUG_NAME,
  XZ_DEBUGDATA_STUB,
} from "./ElfDebugLink.fixture.js";

const artifactPath = "/artifacts/prog";
const digest = "ab".repeat(32);

const inputFor = (extra: { readonly max_entries?: number } = {}) =>
  inspectElfDebugLinkInputSchema.parse({ path: artifactPath, ...extra });

const parse = async (
  bytes: Buffer,
  extra: { readonly max_entries?: number } = {},
) =>
  elfDebugLinkSchema.parse(
    await parseElfDebugLinkFromHandle(
      elfDebugLinkByteSource(bytes),
      { path: artifactPath, sha256: digest, bytes: bytes.length },
      inputFor(extra),
    ),
  );

it("reads a little-endian debuglink CRC, build-id, and lookup paths", async () => {
  const report = await parse(elfDebugLinkFixture());
  expect(report).toMatchObject({
    format: "elf64",
    byte_order: "little",
    machine: 62,
    type_name: "shared",
    debuglink: {
      status: "present",
      filename: {
        text: FIXTURE_DEBUG_NAME,
        encoding: "latin1",
        trust: "observed-untrusted",
      },
      crc32_hex: "12345678",
      reason: null,
    },
    build_id: {
      status: "observed",
      hex: FIXTURE_BUILD_ID_HEX,
      ids: [FIXTURE_BUILD_ID_HEX],
    },
    coverage: { status: "complete", examined_sections: 1 },
  });
  expect(report.lookup_paths.map((entry) => entry.kind)).toEqual([
    "build_id",
    "debug_subdirectory",
    "global_debug_directory",
  ]);
  expect(report.lookup_paths[0]?.path).toBe(
    "/usr/lib/debug/.build-id/01/23456789abcdef0123456789abcdef01234567.debug",
  );
  expect(report.candidate).toBeNull();
  expect(report.verification).toBeNull();
});

it("keeps the CRC across padding, trailing bytes, and malformed names", async () => {
  const padded = Buffer.from([0x61, 0x62, 0, 0, 0xef, 0xcd, 0xab, 0x89]);
  const aligned = Buffer.from([0x61, 0x62, 0x63, 0, 4, 3, 2, 1]);
  expect(
    (await parse(elfDebugLinkFixture({ debuglink: padded }))).debuglink,
  ).toMatchObject({
    status: "present",
    crc32_hex: "89abcdef",
    filename: { text: "ab" },
  });
  const trailing = Buffer.concat([aligned, Buffer.from([0xff, 0x01])]);
  expect(
    (await parse(elfDebugLinkFixture({ debuglink: trailing }))).debuglink
      .crc32_hex,
  ).toBe("01020304");
  const overlong = debuglinkSection("a".repeat(4097), 0x0a0b0c0d, true);
  expect(
    (await parse(elfDebugLinkFixture({ debuglink: overlong }))).debuglink,
  ).toMatchObject({
    status: "malformed",
    filename: null,
    crc32_hex: "0a0b0c0d",
    reason: "debuglink_name_exceeds_limit",
  });
  const empty = await parse(
    elfDebugLinkFixture({ debuglink: debuglinkSection("", 0x11223344, true) }),
  );
  expect(empty.debuglink).toMatchObject({
    status: "malformed",
    filename: null,
    crc32_hex: "11223344",
    reason: "debuglink_empty_name",
  });
});

it("keeps a Latin1 debuglink byte as untrusted text", async () => {
  const report = await parse(
    elfDebugLinkFixture({
      debuglink: debuglinkSection("\xff", 0x00000001, true),
    }),
  );
  expect(report.debuglink.filename).toEqual({
    text: "\xff",
    encoding: "latin1",
    trust: "observed-untrusted",
  });
});

it("does not decode a duplicate, compressed, or nobits debuglink", async () => {
  expect(
    (await parse(elfDebugLinkFixture({ repeatDebuglink: true }))).debuglink,
  ).toMatchObject({
    status: "malformed",
    location: null,
    crc32_hex: null,
    reason: "debuglink_duplicate_section",
  });
  expect(
    (await parse(elfDebugLinkFixture({ debuglinkFlags: 0x800 }))).debuglink,
  ).toMatchObject({
    status: "unsupported",
    crc32_hex: null,
    reason: "debuglink_section_compressed",
  });
  expect(
    (await parse(elfDebugLinkFixture({ debuglinkType: 8 }))).debuglink,
  ).toMatchObject({
    status: "malformed",
    location: null,
    reason: "debuglink_not_file_backed",
  });
});

it("reads debugaltlink and reports xz debugdata without decoding it", async () => {
  const build = Buffer.from("abcd", "hex");
  const report = await parse(
    elfDebugLinkFixture({
      debugaltlink: debugaltlinkSection("alt.dwz", build),
      debugdata: XZ_DEBUGDATA_STUB,
    }),
  );
  expect(report.debugaltlink).toMatchObject({
    status: "present",
    filename: { text: "alt.dwz", trust: "observed-untrusted" },
    build_id_hex: "abcd",
  });
  expect(report.debugdata).toMatchObject({
    status: "present",
    xz_magic: true,
    reason: null,
  });
  expect(report.debugdata.location?.bytes).toBe(XZ_DEBUGDATA_STUB.length);
  expect(
    report.lookup_paths.some((entry) => entry.kind === "alt_build_id"),
  ).toBe(true);
  expect(
    (
      await parse(
        elfDebugLinkFixture({ debugdata: Buffer.from("notxz!", "latin1") }),
      )
    ).debugdata,
  ).toMatchObject({
    status: "malformed",
    xz_magic: false,
    reason: "debugdata_not_xz",
  });
  expect(
    (await parse(elfDebugLinkFixture({ debugdata: Buffer.from([0xfd]) })))
      .debugdata,
  ).toMatchObject({
    status: "malformed",
    xz_magic: false,
    reason: "debugdata_truncated",
  });
});

it("reports conflicting build-ids without selecting a lookup path", async () => {
  const notes = Buffer.concat([
    gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, true),
    gnuBuildIdNote("aa".repeat(20), true),
  ]);
  const report = await parse(elfDebugLinkFixture({ notes }));
  expect(report.build_id.status).toBe("conflict");
  expect(report.build_id.hex).toBeNull();
  expect(report.build_id.ids).toEqual([FIXTURE_BUILD_ID_HEX, "aa".repeat(20)]);
  // Each contributing note keeps its file ranges so a conflict is traceable.
  const [first, second] = report.build_id.sources;
  expect(report.build_id.sources.map((source) => source.hex)).toEqual([
    FIXTURE_BUILD_ID_HEX,
    "aa".repeat(20),
  ]);
  expect(first?.descriptor).toEqual({
    offset: (first?.note.offset ?? 0) + 16,
    bytes: 20,
  });
  expect(second?.note.offset).toBe(
    (first?.note.offset ?? 0) + (first?.note.bytes ?? 0),
  );
  expect(report.lookup_paths.some((entry) => entry.kind === "build_id")).toBe(
    false,
  );
  expect(report.limitations).toContain(
    ELF_DEBUG_LINK_MULTIPLE_BUILD_IDS_LIMITATION,
  );
  expect(report.coverage.status).toBe("complete");
});

it("keeps an observed build-id when section names are unavailable", async () => {
  const report = await parse(elfDebugLinkFixture({ sectionNames: false }));
  expect(report.debuglink.status).toBe("unknown");
  expect(report.debugaltlink.status).toBe("unknown");
  expect(report.debugdata.status).toBe("unknown");
  expect(report.build_id).toMatchObject({
    status: "observed",
    hex: FIXTURE_BUILD_ID_HEX,
  });
  expect(report.coverage.status).toBe("partial");
  expect(report.limitations).toContain(
    "ELF section names are unavailable because no section-name string table is declared",
  );
});

it("charges unrelated entries toward the build-id scan allowance", async () => {
  const notes = Buffer.concat([
    elfNote("stapsdt", 3, Buffer.alloc(40)),
    gnuBuildIdNote(FIXTURE_BUILD_ID_HEX),
  ]);
  const image = elfDebugLinkFixture({ notes });
  await expect(parse(image, { max_entries: 1 })).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        limit: { name: "max_entries", maximum: 1, required: 2 },
      }),
    }),
  );
});

it("reads the build-id beside glibc's SystemTap probe notes by default", async () => {
  const probes = Array.from({ length: 79 }, () =>
    elfNote("stapsdt", 3, Buffer.alloc(40)),
  );
  const report = await parse(
    elfDebugLinkFixture({
      notes: Buffer.concat([
        gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, true),
        ...probes,
      ]),
    }),
  );
  expect(report.build_id).toMatchObject({
    status: "observed",
    hex: FIXTURE_BUILD_ID_HEX,
  });
});

it("observes a slash name without producing directory lookup strings", async () => {
  const slashed = await parse(
    elfDebugLinkFixture({
      debuglink: debuglinkSection("dir/prog.debug", 0x12345678, true),
    }),
  );
  expect(slashed.lookup_paths.map((entry) => entry.kind)).toEqual(["build_id"]);
  expect(slashed.limitations).toContain(ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION);
});

it("retains an exact-limit build ID and reports an oversized one as unknown", async () => {
  const atLimit = "cd".repeat(256);
  const image = (hex: string) =>
    elfDebugLinkFixture({ notes: gnuBuildIdNote(hex) });
  expect((await parse(image(atLimit))).build_id).toMatchObject({
    status: "observed",
    hex: atLimit,
    ids: [atLimit],
  });
  expect((await parse(image(atLimit + "cd"))).build_id).toMatchObject({
    status: "unknown",
    hex: null,
    ids: [],
    sources: [],
    reason: "build_id_exceeds_limit",
  });
});

it("keeps readable build-ids beside an oversized GNU build-id note", async () => {
  const notes = Buffer.concat([
    gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, true),
    gnuBuildIdNote("cd".repeat(257), true),
  ]);
  const report = await parse(elfDebugLinkFixture({ notes }));
  expect(report.build_id).toMatchObject({
    status: "unknown",
    hex: null,
    ids: [FIXTURE_BUILD_ID_HEX],
    reason: "build_id_exceeds_limit",
  });
  expect(report.build_id.sources).toHaveLength(1);
  expect(report.build_id.sources[0]).toMatchObject({
    hex: FIXTURE_BUILD_ID_HEX,
  });
  expect(report.limitations).toContain(
    "A GNU build-id exceeds 256 bytes and was not copied.",
  );
});

it("keeps debuglink facts when the note table is malformed", async () => {
  const report = await parse(
    elfDebugLinkFixture({ notes: Buffer.from("not-a-note", "latin1") }),
  );
  expect(report.debuglink.status).toBe("present");
  expect(report.build_id).toMatchObject({
    status: "unknown",
    reason: "note_tables_malformed",
    hex: null,
  });
  expect(report.coverage.status).toBe("partial");
});

const verify = async (
  image: Buffer,
  candidate: Buffer,
  candidatePath: string,
) => {
  const report = await parse(image);
  return elfDebugLinkSchema.parse(
    verifyElfDebugCandidate(
      report,
      {
        path: candidatePath,
        sha256: digest,
        bytes: candidate.length,
        crc32: crc32(candidate),
        prefix: candidate,
      },
      inputFor(),
    ),
  );
};

it("counts legacy .zdebug_info as present candidate debug info", async () => {
  const candidate = elfDebugCandidateFixture({ zdebugInfo: true });
  const sections = readElfImage(candidate, "elf-directory").sections;
  expect(
    sections.some(
      (section) => section.format === "elf" && section.name === ".zdebug_info",
    ),
  ).toBe(true);
  expect(
    sections.some(
      (section) => section.format === "elf" && section.name === ".debug_info",
    ),
  ).toBe(false);
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, crc32(candidate), true),
  });
  const report = await verify(image, candidate, "/artifacts/prog.debug");
  expect(report.candidate).toMatchObject({ debug_info: "present" });
});

/** Point one named section of a little-endian ELF64 candidate past its end. */
const moveSectionPastEnd = (candidate: Buffer, name: string): Buffer => {
  const damaged = Buffer.from(candidate);
  const declared = readElfImage(candidate, "elf-directory").sections.find(
    (section) => section.format === "elf" && section.name === name,
  );
  if (declared?.format !== "elf") throw new Error(`missing ${name}`);
  const table = Number(damaged.readBigUInt64LE(0x28));
  const entry = damaged.readUInt16LE(0x3a);
  for (let index = 0; index < damaged.readUInt16LE(0x3c); index += 1) {
    const at = table + index * entry + 0x18;
    if (damaged.readBigUInt64LE(at) === declared.declared_range.offset) {
      damaged.writeBigUInt64LE(BigInt(damaged.length + 64), at);
      return damaged;
    }
  }
  throw new Error(`no header for ${name}`);
};

it("leaves candidate sections whose range is outside the file unknown", async () => {
  const candidate = moveSectionPastEnd(
    moveSectionPastEnd(elfDebugCandidateFixture(), ".debug_info"),
    ".symtab",
  );
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, crc32(candidate), true),
  });
  const report = await verify(image, candidate, "/artifacts/prog.debug");
  expect(report.verification?.build_id).toMatchObject({ status: "match" });
  expect(report.candidate).toMatchObject({
    debug_info: "unknown",
    symtab: "unknown",
  });
});

it("reports CRC32 and build-id mismatches together", async () => {
  const candidate = elfDebugCandidateFixture({ buildIdHex: "cc".repeat(20) });
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, 0x11111111, true),
  });
  const report = await verify(image, candidate, "/artifacts/other.debug");
  expect(report.verification).toMatchObject({
    status: "does_not_match",
    reason: "crc32_and_build_id_mismatch",
    crc32: { status: "mismatch" },
    build_id: { status: "mismatch" },
  });
});

it("cannot verify when neither CRC32 nor build-id is comparable", async () => {
  const image = elfDebugLinkFixture({ debuglink: null, notes: null });
  const candidate = elfDebugCandidateFixture({ buildIdHex: null });
  const report = await verify(image, candidate, "/artifacts/plain.debug");
  expect(report.debuglink.status).toBe("absent");
  expect(report.build_id.status).toBe("absent");
  expect(report.verification).toMatchObject({
    status: "cannot_verify",
    reason: "no_comparable_identity",
    crc32: { status: "unavailable", reason: "debuglink_crc_absent" },
    build_id: { status: "unavailable", reason: "binary_build_id_absent" },
  });
  expect(report.verification?.crc32.observed_hex).toBe("314f0306");
  expect(report.limitations).toContain(ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION);
});
