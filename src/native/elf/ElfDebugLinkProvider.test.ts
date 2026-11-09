import { expect, it, vi } from "vitest";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { ArtifactFileCancelled } from "../../artifacts/ArtifactFileOperation.js";
import { completedStableArtifactObservation } from "../../artifacts/StableArtifactObservation.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import {
  ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  inspectElfDebugLinkInputSchema,
  type ElfDebugLink,
} from "../../domain/native/elfDebugLink.js";
import { elfDebugLinkFixture } from "./ElfDebugLink.fixture.js";

const image = elfDebugLinkFixture();
const candidateFailure: { current: unknown } = { current: undefined };

vi.mock(import("../../artifacts/readStableArtifact.js"), async (original) => ({
  ...(await original()),
  readStableArtifact: vi.fn(() =>
    Promise.resolve({ bytes: image, sha256: "ab".repeat(32) }),
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
    new ArtifactReaderFailure("integrity", "Candidate changed while read"),
  );
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value.verification?.reason).toBe("candidate_unreadable");
});

it("keeps a failed candidate close visible after an integrity or limit refusal", async () => {
  for (const reason of ["integrity", "limit"] as const) {
    const result = await inspect(
      ArtifactReaderFailure.withCleanup(
        new ArtifactReaderFailure(reason, "Candidate read refused"),
        ArtifactReaderFailure.cleanupObservation(
          new Error("close failed"),
          "/artifacts/prog.debug",
        ),
      ),
    );
    expect(result.ok).toBe(false);
  }
});

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
  const evidence = error.partialObservation as
    | { normalized_result?: ElfDebugLink }
    | undefined;
  return evidence?.normalized_result;
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

const completedCandidate = {
  sha256: "cd".repeat(32),
  size: 8192,
  prefix: image.subarray(0, 64),
};

it("keeps a completed candidate stream's identity when cancellation arrives during close", async () => {
  const result = await inspect(
    new ArtifactFileCancelled({
      reason: new Error("stop"),
      outcome: { kind: "completed", value: completedCandidate },
    }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const report = retainedReport(result.error);
  expect(report?.artifact.sha256).toBe("ab".repeat(32));
  expect(report?.candidate).toMatchObject({
    path: "/artifacts/prog.debug",
    sha256: "cd".repeat(32),
    bytes: 8192,
  });
  expect(report?.limitations).not.toContain(
    ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  );
});

it("recovers a completed stream's whole-file size, not its prefix length", () => {
  expect(
    completedStableArtifactObservation(
      new ArtifactFileCancelled({
        reason: new Error("stop"),
        outcome: { kind: "completed", value: completedCandidate },
      }),
      "/artifacts/prog.debug",
    ),
  ).toEqual({
    kind: "file-snapshot-hash",
    path: "/artifacts/prog.debug",
    sha256: "cd".repeat(32),
    bytes: 8192,
  });
});
