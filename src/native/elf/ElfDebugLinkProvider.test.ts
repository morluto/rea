import { primaryAnalysisError } from "../../domain/analysisErrorBase.js";
import { expect, it, vi } from "vitest";

import { ArtifactReaderFailure } from "../../resources/ArtifactReader.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  DEFAULT_ELF_DEBUG_CANDIDATE_BYTES,
  ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  inspectElfDebugLinkInputSchema,
  elfDebugLinkSchema,
} from "../../domain/native/elfDebugLink.js";
import { elfDebugLinkFixture } from "./ElfDebugLink.fixture.js";

const image = elfDebugLinkFixture();
const imageBytes: { current: Buffer } = { current: image };
const candidateFailure: { current: unknown } = { current: undefined };

vi.mock(import("../../resources/index.js"), async (original) => ({
  ...(await original()),
  withStableArtifactHandle: vi.fn(
    async (
      _path: string,
      _maxBytes: number,
      options: {
        readonly retainBytes?: (size: number) => number;
        readonly onIdentity?: (identity: {
          readonly sha256: string;
          readonly bytes: number;
        }) => void;
      },
      useFile: (handle: {
        readonly size: number;
        readonly sha256: string;
        readonly prefix: Buffer;
        readonly readRange: (offset: number, length: number) => Promise<Buffer>;
      }) => Promise<unknown>,
    ) => {
      const bytes = imageBytes.current;
      const sha256 = "ab".repeat(32);
      options.onIdentity?.({ sha256, bytes: bytes.length });
      const retained = options.retainBytes?.(bytes.length) ?? 0;
      return useFile({
        size: bytes.length,
        sha256,
        prefix: bytes.subarray(0, Math.min(retained, bytes.length)),
        readRange: (offset, length) =>
          Promise.resolve(
            bytes.subarray(offset, Math.min(bytes.length, offset + length)),
          ),
      });
    },
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
      { observedBytes: BigInt(DEFAULT_ELF_DEBUG_CANDIDATE_BYTES) + 1n },
    ),
    primary: {
      _tag: "AnalysisResourceConstraintError",
      resource: "file-size",
      reportedLimits: {
        boundary: "max_candidate_bytes",
        maximum: DEFAULT_ELF_DEBUG_CANDIDATE_BYTES,
      },
      limit: {
        control_kind: "parameter",
        parameter: "max_candidate_bytes",
        effective_value: DEFAULT_ELF_DEBUG_CANDIDATE_BYTES,
        unit: "bytes",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        default_value: DEFAULT_ELF_DEBUG_CANDIDATE_BYTES,
        applies_at: "next_call",
        required_value: DEFAULT_ELF_DEBUG_CANDIDATE_BYTES + 1,
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

it("refuses a candidate exceeding max_candidate_bytes with details.limit and retains image linkage", async () => {
  candidateFailure.current = new ArtifactReaderFailure(
    "limit",
    "Candidate exceeded its read budget",
    { observedBytes: 512n },
  );
  const result = await new ElfDebugLinkProvider().inspect(
    inspectElfDebugLinkInputSchema.parse({
      path: "/artifacts/prog",
      candidate_path: "/artifacts/prog.debug",
      max_candidate_bytes: 256,
    }),
  );
  if (result.ok) throw new Error("Expected max_candidate_bytes refusal");
  if (!(result.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected AnalysisResourceConstraintError");
  const projected = projectAnalysisError(result.error);
  expect(projected).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      reported_limits: {
        boundary: "max_candidate_bytes",
        maximum: 256,
        required: "512",
      },
      limit: {
        control_kind: "parameter",
        parameter: "max_candidate_bytes",
        effective_value: 256,
        unit: "bytes",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        default_value: DEFAULT_ELF_DEBUG_CANDIDATE_BYTES,
        applies_at: "next_call",
        required_value: 512,
      },
      refusal: {
        kind: "adjustable_budget",
        operation: "inspect_elf_debug_link",
        control: "max_candidate_bytes",
      },
    },
  });
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

it.each([
  { label: "omitted observedBytes", observedBytes: undefined },
  {
    label: "observedBytes above MAX_SAFE_INTEGER",
    observedBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  },
])(
  "omits required_value on max_candidate_bytes refusal when $label",
  async ({ observedBytes }) => {
    candidateFailure.current = new ArtifactReaderFailure(
      "limit",
      "Candidate exceeded its read budget",
      observedBytes === undefined ? {} : { observedBytes },
    );
    const result = await new ElfDebugLinkProvider().inspect(
      inspectElfDebugLinkInputSchema.parse({
        path: "/artifacts/prog",
        candidate_path: "/artifacts/prog.debug",
        max_candidate_bytes: 256,
      }),
    );
    if (result.ok) throw new Error("Expected max_candidate_bytes refusal");
    if (!(result.error instanceof AnalysisResourceConstraintError))
      throw new Error("Expected AnalysisResourceConstraintError");
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("resource_constraint");
    const details = projected.details as {
      limit?: Record<string, unknown>;
      refusal?: Record<string, unknown>;
      reported_limits?: Record<string, unknown>;
    };
    expect(details.limit).not.toHaveProperty("required_value");
    expect(details.refusal).not.toHaveProperty("required_value");
    if (observedBytes === undefined) {
      expect(details.reported_limits).not.toHaveProperty("required");
    } else {
      expect(details.reported_limits?.required).toBe(String(observedBytes));
    }
  },
);

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
