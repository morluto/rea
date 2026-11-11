import { expect, it } from "vitest";
import { ElfDebugLinkService } from "./ElfDebugLinkService.js";
import { ELF_DEBUG_LINK_PROVIDER } from "../../domain/investigationProviders.js";
import {
  deriveDebugFileLookupPaths,
  ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
  ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
  ELF_DEBUG_LINK_LIMITATIONS,
  type ElfDebugLink,
} from "../../domain/native/elfDebugLink.js";
import { ok } from "../../domain/result.js";
import { parseEvidence } from "../../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

const identity = ELF_DEBUG_LINK_PROVIDER;
const digest = "a".repeat(64);
const report: ElfDebugLink = {
  artifact: { path: "/artifacts/prog", sha256: digest, bytes: 512 },
  format: "elf64",
  byte_order: "little",
  machine: 62,
  type: 3,
  type_name: "shared",
  debuglink: {
    status: "absent",
    location: null,
    filename: null,
    crc32_hex: null,
    reason: null,
  },
  debugaltlink: {
    status: "absent",
    location: null,
    filename: null,
    build_id_hex: null,
    reason: null,
  },
  debugdata: {
    status: "absent",
    location: null,
    xz_magic: null,
    reason: null,
  },
  build_id: { status: "absent", hex: null, ids: [], sources: [], reason: null },
  lookup_paths: [],
  candidate: null,
  verification: null,
  coverage: { status: "complete", examined_sections: 0 },
  limitations: [...ELF_DEBUG_LINK_LIMITATIONS],
};

const serviceFor = (value: ElfDebugLink) =>
  new ElfDebugLinkService({
    identity,
    inspect: () => Promise.resolve(ok(value)),
  });

it("rejects an empty candidate and extra arguments before reading", async () => {
  let calls = 0;
  const service = new ElfDebugLinkService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  const emptyCandidate = await service.inspect({
    path: report.artifact.path,
    candidate_path: "",
  });
  expect(extra.ok).toBe(false);
  expect(emptyCandidate.ok).toBe(false);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  if (!emptyCandidate.ok)
    expect(emptyCandidate.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it.each([
  [62, "x86_64"],
  [20, "powerpc"],
] as const)("records machine %s as %s", async (machine, architecture) => {
  const result = await serviceFor({ ...report, machine }).inspect({
    path: report.artifact.path,
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { format: "elf", architecture },
    normalized_result: { ...report, machine },
  });
});

it("rejects a report whose type name, lookup paths, or verification disagree", async () => {
  const linked: ElfDebugLink = {
    ...report,
    debuglink: {
      status: "present",
      location: { offset: 64, bytes: 16 },
      filename: {
        text: "prog.debug",
        encoding: "latin1",
        trust: "observed-untrusted",
      },
      crc32_hex: "12345678",
      reason: null,
    },
    build_id: {
      status: "observed",
      hex: "abcd",
      ids: ["abcd"],
      sources: [],
      reason: null,
    },
    lookup_paths: deriveDebugFileLookupPaths({
      binaryPath: report.artifact.path,
      debuglinkName: "prog.debug",
      buildIdHex: "abcd",
      altBuildIdHex: null,
    }),
    coverage: { status: "complete", examined_sections: 1 },
  };
  const cases: ElfDebugLink[] = [
    { ...report, type_name: "executable" },
    {
      ...linked,
      lookup_paths: linked.lookup_paths.map((entry) =>
        entry.kind === "build_id" ? { ...entry, path: "/tmp/other" } : entry,
      ),
    },
    {
      ...linked,
      candidate: {
        path: "/artifacts/prog.debug",
        sha256: digest,
        bytes: 32,
        format: "elf64",
        byte_order: "little",
        debug_info: "present",
        symtab: "present",
      },
      verification: {
        status: "matches",
        reason: null,
        crc32: {
          status: "match",
          expected_hex: "00000000",
          observed_hex: "00000000",
          reason: null,
        },
        build_id: {
          status: "match",
          binary_hex: "abcd",
          candidate_hex: "abcd",
          reason: null,
        },
      },
    },
  ];
  for (const value of cases) {
    const result = await serviceFor(value).inspect({
      path: report.artifact.path,
      ...(value.candidate === null
        ? {}
        : { candidate_path: value.candidate.path }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
  }
  const unexpectedCandidate = await serviceFor({
    ...report,
    candidate: {
      path: "/artifacts/prog.debug",
      sha256: digest,
      bytes: 32,
      format: null,
      byte_order: null,
      debug_info: "not_elf",
      symtab: "not_elf",
    },
    verification: {
      status: "cannot_verify",
      reason: "no_comparable_identity",
      crc32: {
        status: "unavailable",
        expected_hex: null,
        observed_hex: "00000000",
        reason: "debuglink_crc_absent",
      },
      build_id: {
        status: "unavailable",
        binary_hex: null,
        candidate_hex: null,
        reason: "binary_build_id_absent",
      },
    },
    limitations: [
      ...ELF_DEBUG_LINK_LIMITATIONS,
      "Neither the debuglink CRC32 nor the GNU build-id could be compared with the candidate.",
    ],
  }).inspect({ path: report.artifact.path });
  expect(unexpectedCandidate.ok).toBe(false);
});

it("accepts an unreadable-candidate verdict only with its limitations", async () => {
  const unreadable: ElfDebugLink = {
    ...report,
    candidate: null,
    verification: {
      status: "cannot_verify",
      reason: "candidate_unreadable",
      crc32: {
        status: "unavailable",
        expected_hex: null,
        observed_hex: null,
        reason: "candidate_unreadable",
      },
      build_id: {
        status: "unavailable",
        binary_hex: null,
        candidate_hex: null,
        reason: "candidate_unreadable",
      },
    },
    limitations: [
      ...ELF_DEBUG_LINK_LIMITATIONS,
      ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
      ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
    ],
  };
  const input = {
    path: report.artifact.path,
    candidate_path: "/artifacts/missing.debug",
  };
  const accepted = await serviceFor(unreadable).inspect(input);
  if (!accepted.ok) throw accepted.error;
  expect(accepted.value.normalized_result).toEqual(unreadable);
  const unlabelled = await serviceFor({
    ...unreadable,
    limitations: [
      ...ELF_DEBUG_LINK_LIMITATIONS,
      ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
    ],
  }).inspect(input);
  expect(unlabelled.ok).toBe(false);
});

it("retains a completed observation if the caller cancels while the provider completes", async () => {
  const controller = new AbortController();
  const reason = { request: "late elf debug link cancellation" };
  const service = new ElfDebugLinkService({
    identity,
    inspect: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const late = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(late).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  if (late.ok) throw new Error("Expected late cancellation");
  expect(late.error).toBeInstanceOf(AnalysisCancelledError);
  expect(late.error.cause).toBe(reason);
  expect(parseEvidence(late.error.partialObservation)).toMatchObject({
    operation: "inspect_elf_debug_link",
    confidence: "observed",
    subject: { format: "elf", architecture: "x86_64" },
    normalized_result: report,
  });
});
