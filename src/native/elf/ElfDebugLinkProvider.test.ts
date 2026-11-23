import { primaryAnalysisError } from "../../domain/analysisErrorBase.js";
import { expect, it, vi } from "vitest";

import { ArtifactReaderFailure } from "../../resources/ArtifactReader.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import {
  ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  MAX_ELF_DEBUG_CANDIDATE_BYTES,
  inspectElfDebugLinkInputSchema,
  elfDebugLinkSchema,
} from "../../domain/native/elfDebugLink.js";
import { elfDebugLinkFixture } from "./ElfDebugLink.fixture.js";

const image = elfDebugLinkFixture();
const imageBytes: { current: Buffer } = { current: image };
const candidateFailure: { current: unknown } = { current: undefined };

vi.mock(import("../../resources/index.js"), async (original) => ({
  ...(await original()),
  readStableArtifact: vi.fn(() =>
    Promise.resolve({ bytes: imageBytes.current, sha256: "ab".repeat(32) }),
  ) as never,
  streamStableArtifact: vi.fn(() =>
    Promise.reject(candidateFailure.current),
  ) as never,
}));

const { ElfDebugLinkProvider } = await import("./ElfDebugLinkProvider.js");

const inspect = (cause: unknown) => {
  candidateFailure.current = cause;
  return new ElfDebugLinkProvider().inspect(
    inspectElfDebugLinkInputSchema.parse({
      path: "/artifacts/prog",
      candidate_path: "/artifacts/prog.debug",
    }),
  );
};

it("degrades a changed candidate to candidate_unreadable", async () => {
  const result = await inspect(
    new ArtifactReaderFailure("integrity", "Candidate changed while read", {
      integrityCheck: "container-identity",
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value.verification?.reason).toBe("candidate_unreadable");
});

it.each([
  {
    refusal: new ArtifactReaderFailure(
      "integrity",
      "Candidate changed while read",
      {
        integrityCheck: "container-identity",
      },
    ),
    primary: {
      _tag: "AnalysisArtifactChangedError",
      path: "/artifacts/prog.debug",
      integrityCheck: "container-identity",
    },
  },
  {
    refusal: new ArtifactReaderFailure(
      "limit",
      "Candidate exceeded its read budget",
    ),
    primary: {
      _tag: "AnalysisResourceConstraintError",
      resource: "file-size",
      reportedLimits: {
        boundary: "candidate_bytes",
        maximum: MAX_ELF_DEBUG_CANDIDATE_BYTES,
      },
      fixedAllowance: {
        kind: "input",
        limit: MAX_ELF_DEBUG_CANDIDATE_BYTES,
        unit: "bytes",
      },
    },
  },
])(
  "keeps candidate cleanup and the $refusal.reason primary",
  async ({ refusal, primary }) => {
    const result = await inspect(
      ArtifactReaderFailure.withCleanup(
        refusal,
        ArtifactReaderFailure.cleanupObservation(
          new Error("close failed"),
          "/artifacts/prog.debug",
        ),
      ),
    );
    if (result.ok) throw new Error("Expected a candidate cleanup failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toEqual(["/artifacts/prog.debug"]);
    expect(primaryAnalysisError(result.error)).toMatchObject(primary);
  },
);

it("degrades a candidate data-read EIO to candidate_unreadable", async () => {
  const result = await inspect(
    Object.assign(new Error("i/o error"), { code: "EIO" }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.artifact.sha256).toBe("ab".repeat(32));
    expect(result.value.verification?.reason).toBe("candidate_unreadable");
  }
});

const retainedReport = (error: { partialObservation?: unknown }) => {
  const report = elfDebugLinkSchema.safeParse(error.partialObservation);
  return report.success ? report.data : undefined;
};

it("retains the decoded image report when the candidate read is cancelled", async () => {
  const result = await inspect(
    new ArtifactReaderFailure("cancelled", "Artifact read cancelled"),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  const report = retainedReport(result.error);
  expect(report?.artifact).toEqual({
    path: "/artifacts/prog",
    sha256: "ab".repeat(32),
    bytes: image.length,
  });
  expect(report?.candidate).toBeNull();
  expect(report?.verification).toBeNull();
  expect(report?.limitations).toContain(
    ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  );
});

it("retains the completed image snapshot when ELF decoding fails", async () => {
  const garbage = Buffer.alloc(128, 0x41);
  imageBytes.current = garbage;
  try {
    const result = await new ElfDebugLinkProvider().inspect(
      inspectElfDebugLinkInputSchema.parse({ path: "/artifacts/prog" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path: "/artifacts/prog",
      sha256: "ab".repeat(32),
      bytes: garbage.length,
    });
  } finally {
    imageBytes.current = image;
  }
});
