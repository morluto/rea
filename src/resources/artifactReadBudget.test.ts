import { expect, it } from "vitest";
import { maxFileBytesReadBudget } from "../domain/artifactReadBudget.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  artifactReadBudgetConstraint,
  budgetArtifactReads,
} from "./artifactReadBudget.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

const bytes = Buffer.alloc(1 << 20, 7);
const underlyingReads: { offset: number; length: number }[] = [];
const handle = {
  sha256: "a".repeat(64),
  size: bytes.length,
  prefix: bytes.subarray(0, 4096),
  readRange: async (offset: number, length: number) => {
    underlyingReads.push({ offset, length });
    return bytes.subarray(offset, offset + length);
  },
};

it("counts the parsed prefix and positional reads, not the file size", async () => {
  expect(() =>
    budgetArtifactReads(handle, maxFileBytesReadBudget(4095, 1 << 29)),
  ).toThrow(ArtifactReaderFailure);
  const budgeted = budgetArtifactReads(
    handle,
    maxFileBytesReadBudget(4196, 1 << 29),
  );
  await expect(budgeted.readRange(0, 60)).resolves.toHaveLength(60);
  await expect(budgeted.readRange(500_000, 40)).resolves.toHaveLength(40);
  const refusal = await budgeted.readRange(0, 1).catch((cause) => cause);
  // The refused read never reaches the descriptor, so no oversized buffer is read.
  expect(underlyingReads).toEqual([
    { offset: 0, length: 60 },
    { offset: 500_000, length: 40 },
  ]);
  expect(refusal).toBeInstanceOf(ArtifactReaderFailure);
  expect(refusal).toMatchObject({ reason: "limit", boundary: "capacity" });
  const error = artifactReadBudgetConstraint("inspect_pe_imports", refusal, {
    max_file_bytes: 4196,
  });
  expect(error).toMatchObject({
    resource: "capacity",
    retryable: false,
    reportedLimits: { max_file_bytes: 4196, required_read_bytes: 4197 },
  });
  expect(projectAnalysisError(error!).details).toMatchObject({
    limit: {
      control_kind: "parameter",
      parameter: "max_file_bytes",
      effective_value: 4196,
      minimum: 64,
      maximum: 1 << 29,
      default_value: 67108864,
      applies_at: "next_call",
    },
  });
  // The reads so far are only a lower bound, so no admitting value is claimed.
  expect(projectAnalysisError(error!).details).not.toHaveProperty(
    "limit.required_value",
  );
});

it("leaves other reader limits to their own projection", () => {
  expect(
    artifactReadBudgetConstraint(
      "inspect_pe_imports",
      new ArtifactReaderFailure("limit", "other", { boundary: "capacity" }),
      { max_file_bytes: 100 },
    ),
  ).toBeUndefined();
});
