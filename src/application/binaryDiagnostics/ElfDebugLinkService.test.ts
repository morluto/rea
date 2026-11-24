import { lateCancellationEvidence } from "../../../tests/support/lateCancellationEvidence.js";
import { resolvedAnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { expect, it } from "vitest";
import { ElfDebugLinkService } from "./ElfDebugLinkService.js";
import { ELF_DEBUG_LINK_PROVIDER } from "../../domain/investigationProviders.js";
import {
  DEFAULT_INSPECT_ELF_DEBUG_LINK_ENTRIES,
  deriveDebugFileLookupPaths,
  ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_COMPARISON_INCOMPLETE_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
  MAX_ELF_DEBUG_CANDIDATE_BYTES,
  ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
  ELF_DEBUG_LINK_LIMITATIONS,
  type ElfDebugLink,
} from "../../domain/native/elfDebugLink.js";
import { err, ok } from "../../domain/result.js";
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
  limitation_codes: ["standing_caveats"],
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
    subject: { identity: { format: "elf", architecture } },
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
  const candidate = {
    path: "/artifacts/prog.debug",
    sha256: digest,
    bytes: 32,
    format: "elf64",
    byte_order: "little",
    debug_info: "present",
    symtab: "present",
  } as const;
  const verification = {
    status: "matches",
    reason: null,
    crc32: {
      status: "match",
      expected_hex: "12345678",
      observed_hex: "12345678",
      reason: null,
    },
    build_id: {
      status: "match",
      binary_hex: "abcd",
      candidate_hex: "abcd",
      reason: null,
    },
  } as const;
  const interruptedCandidate = {
    ...candidate,
    format: null,
    byte_order: null,
    debug_info: "unknown",
    symtab: "unknown",
  } as const;
  const interrupted: ElfDebugLink = {
    ...linked,
    candidate: interruptedCandidate,
    limitation_codes: [
      ...linked.limitation_codes,
      "candidate_comparison_incomplete",
    ],
    limitations: [
      ...linked.limitations,
      ELF_DEBUG_LINK_CANDIDATE_COMPARISON_INCOMPLETE_LIMITATION,
    ],
  };
  const imageInput = { path: report.artifact.path };
  const selectedInput = { ...imageInput, candidate_path: candidate.path };
  const cases = [
    { value: { ...report, type_name: "executable" }, input: imageInput },
    {
      value: {
        ...linked,
        lookup_paths: linked.lookup_paths.map((entry) =>
          entry.kind === "build_id" ? { ...entry, path: "/tmp/other" } : entry,
        ),
      },
      input: imageInput,
    },
    {
      value: { ...linked, candidate, verification },
      input: imageInput,
    },
    {
      value: {
        ...linked,
        candidate,
        verification: {
          ...verification,
          crc32: {
            ...verification.crc32,
            expected_hex: "00000000",
            observed_hex: "00000000",
          },
        },
      },
      input: selectedInput,
    },
    { value: interrupted, input: selectedInput },
  ] satisfies { value: ElfDebugLink; input: object }[];
  for (const { value, input } of cases) {
    const result = await serviceFor(value).inspect(input);
    if (result.ok) throw new Error("Unexpected debug-link report admission");
    expect(result.error).toBeInstanceOf(AnalysisOutputError);
  }
  for (const invalid of [
    {
      ...interrupted,
      candidate: { ...interruptedCandidate, path: "/artifacts/foreign.debug" },
    },
    {
      ...interrupted,
      candidate: {
        ...interruptedCandidate,
        bytes: MAX_ELF_DEBUG_CANDIDATE_BYTES + 1,
      },
    },
    {
      ...interrupted,
      limitation_codes: [
        ...interrupted.limitation_codes,
        "candidate_unreadable" as const,
      ],
      limitations: [
        ...interrupted.limitations,
        ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
      ],
    },
  ]) {
    const error = new AnalysisCancelledError("inspect_elf_debug_link", {
      partialObservation: invalid,
    });
    const result = await new ElfDebugLinkService({
      identity,
      inspect: () => Promise.resolve(err(error)),
    }).inspect(selectedInput);
    if (result.ok) throw new Error("Expected candidate cancellation");
    expect(result.error.partialObservation).toBe(invalid);
  }
});

it("rejects an unreadable-candidate verdict without its limitation", async () => {
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
    limitation_codes: [...report.limitation_codes, "cannot_verify"],
    limitations: [
      ...ELF_DEBUG_LINK_LIMITATIONS,
      ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
    ],
  };
  const input = {
    path: report.artifact.path,
    candidate_path: "/artifacts/missing.debug",
  };
  const result = await serviceFor(unreadable).inspect(input);
  if (result.ok)
    throw new Error("Expected missing unreadable-candidate limitation to fail");
  expect(result.error).toBeInstanceOf(AnalysisOutputError);

  // Typed limitation_codes drive validation rather than prose matching.
  const reworded = await serviceFor({
    ...report,
    limitations: ["Custom standing caveat prose."],
  }).inspect({ path: report.artifact.path });
  expect(reworded.ok).toBe(true);

  const missingCode = await serviceFor({
    ...report,
    limitation_codes: [],
  }).inspect({ path: report.artifact.path });
  expect(missingCode).toMatchObject({
    ok: false,
    error: expect.any(AnalysisOutputError),
  });
});

it("retains a completed observation if the caller cancels while the provider completes", async () => {
  const evidence = await lateCancellationEvidence(
    report,
    "late elf debug link cancellation",
    (inspect) => new ElfDebugLinkService({ identity, inspect }),
  );
  expect(evidence).toMatchObject({
    operation: "inspect_elf_debug_link",
    confidence: "observed",
    subject: { identity: { format: "elf", architecture: "x86_64" } },
    normalized_result: report,
  });
});

it("keeps omitted and explicitly selected defaults distinct in complete and partial Evidence", async () => {
  for (const failure of [false, true]) {
    const service = new ElfDebugLinkService({
      identity,
      inspect: () =>
        Promise.resolve(
          failure
            ? err(
                new AnalysisCancelledError("inspect_elf_debug_link", {
                  partialObservation: report,
                }),
              )
            : ok(report),
        ),
    });
    const observations = [];
    for (const parameters of [
      { path: report.artifact.path },
      {
        path: report.artifact.path,
        max_entries: DEFAULT_INSPECT_ELF_DEBUG_LINK_ENTRIES,
      },
    ]) {
      const result = await service.inspect(parameters);
      const evidence = parseEvidence(
        result.ok ? result.value : result.error.partialObservation,
      );
      expect(evidence.parameters).toEqual(parameters);
      expect(evidence.normalized_result).toEqual(report);
      observations.push(evidence);
    }
    expect(observations[0]!.evidence_id).not.toBe(observations[1]!.evidence_id);
  }
});

it("keeps caller Evidence after retained cleanup releases and reveals the primary failure", async () => {
  const parameters = {
    path: report.artifact.path,
    candidate_path: "/artifacts/prog.debug",
  };
  const partial: ElfDebugLink = {
    ...report,
    limitation_codes: [...report.limitation_codes, "candidate_read_incomplete"],
    limitations: [
      ...report.limitations,
      ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
    ],
  };
  const primary = new AnalysisCancelledError("inspect_elf_debug_link", {
    partialObservation: partial,
  });
  const completion = { cleanupReleased: false };
  const failure = analysisErrorWithCleanupFailure(
    primary,
    new ProviderCleanupError(identity.id, [parameters.candidate_path], {
      reason: "close failed",
    }),
    "inspect_elf_debug_link",
  ).bindCleanupReleaseClaim(completion);
  const service = new ElfDebugLinkService({
    identity,
    inspect: () => Promise.resolve(err(failure)),
  });
  const result = await service.inspect(parameters);
  if (result.ok) throw new Error("Expected retained cleanup failure");
  expect(result.error).toBe(failure);
  const before = parseEvidence(result.error.partialObservation);
  expect(result.error.cleanupIncomplete).toBe(true);
  completion.cleanupReleased = true;
  const resolved = resolvedAnalysisError(result.error);
  expect(resolved).toBe(primary);
  const after = parseEvidence(resolved.partialObservation);
  expect(after).toEqual(before);
  expect(after.parameters).toEqual(parameters);
  expect(after.normalized_result).toEqual(partial);
});
