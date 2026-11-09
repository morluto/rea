import { crc32 } from "node:zlib";
import { expect, it } from "vitest";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
  ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
  ELF_DEBUG_LINK_MULTIPLE_BUILD_IDS_LIMITATION,
  ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION,
  ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
  elfDebugLinkSchema,
  inspectElfDebugLinkInputSchema,
} from "../../domain/native/elfDebugLink.js";
import { gnuBuildIdNote } from "./ElfNotes.fixture.js";
import { parseElfNotes } from "./ElfNoteParser.js";
import {
  continueGnuDebuglinkCrc32,
  gnuDebuglinkCrc32,
  gnuDebuglinkCrc32Hex,
  parseElfDebugLink,
  unreadableElfDebugCandidate,
  verifyElfDebugCandidate,
} from "./ElfDebugLink.js";
import {
  debugaltlinkSection,
  debuglinkSection,
  elfDebugCandidateFixture,
  elfDebugLinkFixture,
  FIXTURE_BUILD_ID_HEX,
  FIXTURE_DEBUG_NAME,
  XZ_DEBUGDATA_STUB,
} from "./ElfDebugLink.fixture.js";

const artifactPath = "/artifacts/prog";
const digest = "ab".repeat(32);

const inputFor = (extra: { readonly max_entries?: number } = {}) =>
  inspectElfDebugLinkInputSchema.parse({ path: artifactPath, ...extra });

const parse = (
  bytes: Buffer,
  extra: { readonly max_entries?: number } = {},
  path = artifactPath,
) =>
  elfDebugLinkSchema.parse(
    parseElfDebugLink(
      bytes,
      { path, sha256: digest, bytes: bytes.length },
      inspectElfDebugLinkInputSchema.parse({ path, ...extra }),
    ),
  );

it("matches the known CRC32 of 123456789 and chunked continuation", () => {
  const classic = Buffer.from("123456789", "latin1");
  expect(gnuDebuglinkCrc32(classic)).toBe(0xcbf43926);
  expect(gnuDebuglinkCrc32Hex(classic)).toBe("cbf43926");
  const wide = Buffer.alloc(100, 0x5a);
  let continued = 0;
  for (let offset = 0; offset < wide.length; offset += 16)
    continued = crc32(wide.subarray(offset, offset + 16), continued);
  expect(gnuDebuglinkCrc32(wide)).toBe(continued >>> 0);
  expect(gnuDebuglinkCrc32(wide)).toBe(crc32(wide) >>> 0);
});

it("reads a little-endian debuglink CRC, build-id, and lookup paths", () => {
  const report = parse(elfDebugLinkFixture());
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

it("reads a big-endian ELF32 debuglink CRC", () => {
  const report = parse(
    elfDebugLinkFixture({ bits: 32, little: false, machine: 20 }),
  );
  expect(report).toMatchObject({
    format: "elf32",
    byte_order: "big",
    machine: 20,
    debuglink: { status: "present", crc32_hex: "12345678" },
  });
});

it("keeps the CRC across padding, trailing bytes, and an overlong name", () => {
  const padded = debuglinkSection("ab", 0x89abcdef, true);
  expect(padded.length).toBe(8);
  expect(padded.subarray(0, 4).equals(Buffer.from("ab\0\0", "latin1"))).toBe(
    true,
  );
  expect(padded.readUInt32LE(4)).toBe(0x89abcdef);
  const aligned = debuglinkSection("abc", 0x01020304, true);
  expect(aligned.length).toBe(8);
  expect(
    parse(elfDebugLinkFixture({ debuglink: padded })).debuglink,
  ).toMatchObject({
    status: "present",
    crc32_hex: "89abcdef",
    filename: { text: "ab" },
  });
  const trailing = Buffer.concat([aligned, Buffer.from([0xff, 0x01])]);
  expect(
    parse(elfDebugLinkFixture({ debuglink: trailing })).debuglink.crc32_hex,
  ).toBe("01020304");
  const overlong = debuglinkSection("a".repeat(4097), 0x0a0b0c0d, true);
  expect(
    parse(elfDebugLinkFixture({ debuglink: overlong })).debuglink,
  ).toMatchObject({
    status: "malformed",
    filename: null,
    crc32_hex: "0a0b0c0d",
    reason: "debuglink_name_exceeds_limit",
  });
});

it("reports an empty debuglink name without dropping the CRC", () => {
  const report = parse(
    elfDebugLinkFixture({ debuglink: debuglinkSection("", 0x11223344, true) }),
  );
  expect(report.debuglink).toMatchObject({
    status: "malformed",
    filename: null,
    crc32_hex: "11223344",
    reason: "debuglink_empty_name",
  });
});

it("keeps a Latin1 debuglink byte as untrusted text", () => {
  const report = parse(
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

it("does not decode a duplicate, compressed, or nobits debuglink", () => {
  expect(
    parse(elfDebugLinkFixture({ repeatDebuglink: true })).debuglink,
  ).toMatchObject({
    status: "malformed",
    location: null,
    crc32_hex: null,
    reason: "debuglink_duplicate_section",
  });
  expect(
    parse(elfDebugLinkFixture({ debuglinkFlags: 0x800 })).debuglink,
  ).toMatchObject({
    status: "unsupported",
    crc32_hex: null,
    reason: "debuglink_section_compressed",
  });
  expect(
    parse(elfDebugLinkFixture({ debuglinkType: 8 })).debuglink,
  ).toMatchObject({
    status: "malformed",
    location: null,
    reason: "debuglink_not_file_backed",
  });
});

it("reads debugaltlink and reports xz debugdata without decoding it", () => {
  const build = Buffer.from("abcd", "hex");
  const report = parse(
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
    parse(elfDebugLinkFixture({ debugdata: Buffer.from("notxz!", "latin1") }))
      .debugdata,
  ).toMatchObject({
    status: "malformed",
    xz_magic: false,
    reason: "debugdata_not_xz",
  });
  expect(
    parse(elfDebugLinkFixture({ debugdata: Buffer.from([0xfd]) })).debugdata,
  ).toMatchObject({
    status: "malformed",
    xz_magic: false,
    reason: "debugdata_truncated",
  });
});

it("reports conflicting build-ids without selecting a lookup path", () => {
  const notes = Buffer.concat([
    gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, true),
    gnuBuildIdNote("aa".repeat(20), true),
  ]);
  const report = parse(elfDebugLinkFixture({ notes }));
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

it("keeps an observed build-id when section names are unavailable", () => {
  const report = parse(elfDebugLinkFixture({ sectionNames: false }));
  expect(report.debuglink.status).toBe("unknown");
  expect(report.debugaltlink.status).toBe("unknown");
  expect(report.debugdata.status).toBe("unknown");
  expect(report.build_id).toMatchObject({
    status: "observed",
    hex: FIXTURE_BUILD_ID_HEX,
  });
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).toContain(
    "ELF section names are unavailable because no section-name string table is declared",
  );
});

it("fails the note entry budget instead of returning a partial build-id", () => {
  const notes = Buffer.concat([
    gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, true),
    gnuBuildIdNote("bb".repeat(20), true),
  ]);
  expect(() =>
    parseElfDebugLink(
      elfDebugLinkFixture({ notes }),
      { path: artifactPath, sha256: digest, bytes: 1 },
      inputFor({ max_entries: 1 }),
    ),
  ).toThrow(ArtifactReaderFailure);
});

it("preserves parent-directory segments and omits a slash name", () => {
  const preserved = parse(elfDebugLinkFixture(), {}, "/var/tmp/../lib/prog");
  expect(
    preserved.lookup_paths.find(
      (entry) => entry.kind === "global_debug_directory",
    )?.path,
  ).toBe("/usr/lib/debug/var/tmp/../lib/prog.debug");
  const slashed = parse(
    elfDebugLinkFixture({
      debuglink: debuglinkSection("dir/prog.debug", 0x12345678, true),
    }),
  );
  expect(slashed.lookup_paths.map((entry) => entry.kind)).toEqual(["build_id"]);
  expect(slashed.limitations).toContain(ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION);
});

it("refuses an oversized GNU build-id from its raw size without hex-encoding it", () => {
  const notes = gnuBuildIdNote("cd".repeat(257), true);
  const image = elfDebugLinkFixture({ notes });
  const decoded = parseElfNotes(
    image,
    { path: artifactPath, sha256: digest, bytes: image.length },
    { path: artifactPath, max_file_bytes: image.length, max_entries: 32 },
    { maxGnuBuildIdBytes: 256 },
  );
  expect(decoded.entries[0]).toMatchObject({
    descsz: 257,
    gnu: { build_id_hex: null },
  });
  expect(parse(image).build_id).toMatchObject({
    status: "unknown",
    hex: null,
    ids: [],
    sources: [],
    reason: "build_id_exceeds_limit",
  });
});

it("keeps debuglink facts when the note table is malformed", () => {
  const report = parse(
    elfDebugLinkFixture({ notes: Buffer.from("not-a-note", "latin1") }),
  );
  expect(report.debuglink.status).toBe("present");
  expect(report.build_id).toMatchObject({
    status: "unknown",
    reason: "note_tables_malformed",
    hex: null,
  });
  expect(report.coverage.status).toBe("incomplete");
});

const verify = (image: Buffer, candidate: Buffer, candidatePath: string) => {
  const report = parseElfDebugLink(
    image,
    { path: artifactPath, sha256: digest, bytes: image.length },
    inputFor(),
  );
  return elfDebugLinkSchema.parse(
    verifyElfDebugCandidate(
      report,
      {
        path: candidatePath,
        sha256: digest,
        bytes: candidate.length,
        crc32: gnuDebuglinkCrc32(candidate),
        prefix: candidate,
      },
      inputFor(),
    ),
  );
};

it("matches a candidate by CRC32 and build-id and records its sections", () => {
  const candidate = elfDebugCandidateFixture();
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(
      FIXTURE_DEBUG_NAME,
      gnuDebuglinkCrc32(candidate),
      true,
    ),
  });
  const report = verify(image, candidate, "/artifacts/prog.debug");
  expect(report.verification).toMatchObject({
    status: "matches",
    reason: null,
    crc32: { status: "match", observed_hex: gnuDebuglinkCrc32Hex(candidate) },
    build_id: { status: "match", candidate_hex: FIXTURE_BUILD_ID_HEX },
  });
  expect(report.candidate).toMatchObject({
    path: "/artifacts/prog.debug",
    format: "elf64",
    debug_info: "present",
    symtab: "present",
  });
});

it("reports CRC32 and build-id mismatches together", () => {
  const candidate = elfDebugCandidateFixture({ buildIdHex: "cc".repeat(20) });
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, 0x11111111, true),
  });
  const report = verify(image, candidate, "/artifacts/other.debug");
  expect(report.verification).toMatchObject({
    status: "does_not_match",
    reason: "crc32_and_build_id_mismatch",
    crc32: { status: "mismatch" },
    build_id: { status: "mismatch" },
  });
});

it("matches CRC32 of a non-ELF candidate and leaves build-id unverified", () => {
  const candidate = Buffer.from("not an elf", "latin1");
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(
      FIXTURE_DEBUG_NAME,
      gnuDebuglinkCrc32(candidate),
      true,
    ),
  });
  const report = verify(image, candidate, "/artifacts/plain.debug");
  expect(report.candidate).toMatchObject({
    format: null,
    byte_order: null,
    debug_info: "not_elf",
    symtab: "not_elf",
  });
  expect(report.verification).toMatchObject({
    status: "matches",
    crc32: { status: "match" },
    build_id: { status: "unavailable", reason: "candidate_not_elf" },
  });
  expect(report.limitations).toContain(
    ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
  );
});

it("reports a candidate with ELF magic and a bad header as malformed ELF", () => {
  // ELF magic, ELFCLASS64, little-endian, then an unsupported EI_VERSION.
  const candidate = Buffer.alloc(64);
  candidate.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 9]);
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(
      FIXTURE_DEBUG_NAME,
      gnuDebuglinkCrc32(candidate),
      true,
    ),
  });
  const report = verify(image, candidate, "/artifacts/bad-header.debug");
  expect(report.candidate).toMatchObject({
    format: null,
    byte_order: null,
    debug_info: "unknown",
    symtab: "unknown",
  });
  expect(report.verification).toMatchObject({
    status: "matches",
    crc32: { status: "match" },
    build_id: { status: "unavailable", reason: "candidate_elf_malformed" },
  });
});

it("cannot verify when neither CRC32 nor build-id is comparable", () => {
  const image = elfDebugLinkFixture({ debuglink: null, notes: null });
  const candidate = elfDebugCandidateFixture({ buildIdHex: null });
  const report = verify(image, candidate, "/artifacts/plain.debug");
  expect(report.debuglink.status).toBe("absent");
  expect(report.build_id.status).toBe("absent");
  expect(report.verification).toMatchObject({
    status: "cannot_verify",
    reason: "no_comparable_identity",
    crc32: { status: "unavailable", reason: "debuglink_crc_absent" },
    build_id: { status: "unavailable", reason: "binary_build_id_absent" },
  });
  expect(report.verification?.crc32.observed_hex).toBe(
    gnuDebuglinkCrc32Hex(candidate),
  );
  expect(report.limitations).toContain(ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION);
});

it("verifies a streamed candidate by CRC32 when only its header was retained", () => {
  const candidate = elfDebugCandidateFixture();
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(
      FIXTURE_DEBUG_NAME,
      gnuDebuglinkCrc32(candidate),
      true,
    ),
  });
  const report = parseElfDebugLink(
    image,
    { path: artifactPath, sha256: digest, bytes: image.length },
    inputFor(),
  );
  let streamed = 0;
  for (let offset = 0; offset < candidate.length; offset += 7)
    streamed = continueGnuDebuglinkCrc32(
      streamed,
      candidate.subarray(offset, offset + 7),
    );
  const verified = elfDebugLinkSchema.parse(
    verifyElfDebugCandidate(
      report,
      {
        path: "/artifacts/prog.debug",
        sha256: digest,
        bytes: candidate.length,
        crc32: streamed,
        prefix: candidate.subarray(0, 64),
      },
      inputFor(),
    ),
  );
  expect(verified.candidate).toMatchObject({
    format: "elf64",
    byte_order: "little",
    debug_info: "unknown",
    symtab: "unknown",
  });
  expect(verified.verification).toMatchObject({
    status: "matches",
    crc32: { status: "match" },
    build_id: { status: "unavailable", reason: "candidate_build_id_unknown" },
  });
  expect(verified.limitations).toEqual(
    expect.arrayContaining([
      ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION,
      ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
    ]),
  );
});

it("keeps the image linkage when the candidate exceeds the note entry budget", () => {
  const candidate = elfDebugLinkFixture({
    debuglink: null,
    notes: Buffer.concat([
      gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, true),
      gnuBuildIdNote("bb".repeat(20), true),
    ]),
    debugInfo: Buffer.from("debug-info", "latin1"),
  });
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(
      FIXTURE_DEBUG_NAME,
      gnuDebuglinkCrc32(candidate),
      true,
    ),
  });
  const input = inputFor({ max_entries: 1 });
  const report = parseElfDebugLink(
    image,
    { path: artifactPath, sha256: digest, bytes: image.length },
    input,
  );
  const verified = elfDebugLinkSchema.parse(
    verifyElfDebugCandidate(
      report,
      {
        path: "/artifacts/prog.debug",
        sha256: digest,
        bytes: candidate.length,
        crc32: gnuDebuglinkCrc32(candidate),
        prefix: candidate,
      },
      input,
    ),
  );
  expect(verified.debuglink.status).toBe("present");
  expect(verified.build_id).toMatchObject({
    status: "observed",
    hex: FIXTURE_BUILD_ID_HEX,
  });
  expect(verified.candidate).toMatchObject({
    format: "elf64",
    debug_info: "present",
    symtab: "absent",
  });
  expect(verified.verification).toMatchObject({
    status: "matches",
    crc32: { status: "match" },
    build_id: {
      status: "unavailable",
      binary_hex: FIXTURE_BUILD_ID_HEX,
      candidate_hex: null,
      reason: "candidate_build_id_unknown",
    },
  });
  expect(verified.limitations).toEqual(
    expect.arrayContaining([
      ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
      ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
    ]),
  );
});

it("keeps the image linkage when the candidate cannot be read", () => {
  const image = elfDebugLinkFixture({
    debuglink: debuglinkSection(FIXTURE_DEBUG_NAME, 0x12345678, true),
  });
  const report = parseElfDebugLink(
    image,
    { path: artifactPath, sha256: digest, bytes: image.length },
    inputFor(),
  );
  const unreadable = elfDebugLinkSchema.parse(
    unreadableElfDebugCandidate(report),
  );
  expect(unreadable.debuglink).toEqual(report.debuglink);
  expect(unreadable.lookup_paths).toEqual(report.lookup_paths);
  expect(unreadable.candidate).toBeNull();
  expect(unreadable.verification).toEqual({
    status: "cannot_verify",
    reason: "candidate_unreadable",
    crc32: {
      status: "unavailable",
      expected_hex: "12345678",
      observed_hex: null,
      reason: "candidate_unreadable",
    },
    build_id: {
      status: "unavailable",
      binary_hex: FIXTURE_BUILD_ID_HEX,
      candidate_hex: null,
      reason: "candidate_unreadable",
    },
  });
  expect(unreadable.limitations).toEqual(
    expect.arrayContaining([
      ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
      ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
    ]),
  );
});
