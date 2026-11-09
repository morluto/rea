import { expect, it, vi } from "vitest";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { inspectElfDebugLinkInputSchema } from "../../domain/native/elfDebugLink.js";
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
