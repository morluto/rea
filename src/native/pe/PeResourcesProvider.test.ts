import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  MAX_INSPECT_PE_DIRECTORY_ENTRIES,
  MAX_INSPECT_PE_FILE_BYTES,
  inspectPeResourcesInputSchema,
} from "../../domain/native/peResources.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { PeResourcesProvider } from "./PeResourcesProvider.js";
import { peResourceFixture } from "../../domain/pe/peResources.fixture.js";

const inspect = async (
  path: string,
  input: {
    readonly max_file_bytes?: number;
    readonly max_entries?: number;
  } = {},
) => {
  const provider = new PeResourcesProvider();
  try {
    return await provider.inspect(
      inspectPeResourcesInputSchema.parse({ path, ...input }),
    );
  } finally {
    await provider.close();
  }
};

describe("PE resource provider budget reporting", () => {
  it("refuses reads past max_file_bytes with a typed parameter limit", async () => {
    const root = await createTestTempDirectory("rea-pe-budget-advice-");
    const path = join(root, "resource.exe");
    await writeFile(path, peResourceFixture().bytes);
    const result = await inspect(path, { max_file_bytes: 64 });
    if (result.ok) throw new Error("Expected a refusal");
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    const error = result.error as AnalysisResourceConstraintError;
    expect(error).toMatchObject({
      resource: "capacity",
      retryable: false,
      reportedLimits: {
        max_file_bytes: 64,
        required_read_bytes: expect.any(Number),
      },
    });
    // The projected advice must not send the caller to worker write limits.
    expect(projectAnalysisError(error)).toMatchObject({
      retryable: false,
      remediation: { action: expect.stringContaining("max_file_bytes") },
      details: {
        limit: {
          control_kind: "parameter",
          parameter: "max_file_bytes",
          effective_value: 64,
          unit: "bytes",
          minimum: 64,
          maximum: MAX_INSPECT_PE_FILE_BYTES,
          default_value: 67108864,
          applies_at: "next_call",
        },
      },
    });
  });

  it("keeps an entry budget refusal non-retryable with its own advice", async () => {
    const root = await createTestTempDirectory("rea-pe-entry-advice-");
    const path = join(root, "resource.exe");
    await writeFile(path, peResourceFixture().bytes);
    const result = await inspect(path, { max_entries: 1 });
    if (result.ok) throw new Error("Expected a refusal");
    const error = result.error as AnalysisResourceConstraintError;
    expect(error.resource).toBe("capacity");
    expect(error.reportedLimits).toMatchObject({ max_entries: 1 });
    expect(error.remediationAction).toContain("max_entries");
    expect(projectAnalysisError(error)).toMatchObject({
      retryable: false,
      remediation: { action: error.remediationAction },
      details: {
        reported_limits: {
          boundary: "max_entries",
          maximum: 1,
          max_entries: 1,
        },
      },
    });
  });

  // Avoid reserving the file on filesystems without sparse truncation.
  it.skipIf(process.platform === "win32")(
    "admits a file above max_file_bytes when its headers and directories fit",
    async () => {
      // The Godot 4.7.2 editor (181 MB) reads a few MiB of tables; the
      // allowance bounds those reads, not the file size.
      const root = await createTestTempDirectory("rea-pe-sparse-");
      const sparse = join(root, "sparse.exe");
      const { bytes } = peResourceFixture();
      await writeFile(sparse, bytes);
      await truncate(sparse, 67108864 + 4096);
      const small = await inspect(join(root, "sparse.exe"));
      if (!small.ok) throw small.error;
      expect(small.value).toMatchObject({
        artifact: { bytes: 67108864 + 4096 },
        coverage: { status: "complete", resources: 5 },
      });
    },
  );

  it("names the resource-directory ceiling instead of an impossible bound", async () => {
    const root = await createTestTempDirectory("rea-pe-max-entries-");
    const resources = [
      { type: "first" },
      { type: "second" },
      ...Array.from({ length: 65_535 }, (_, type) => ({ type })),
    ];
    const fixture = peResourceFixture(false, resources, 2 * 1024 * 1024);
    const directory = fixture.directoryOffsets[0];
    if (directory === undefined)
      throw new Error("Expected a resource directory");
    expect(fixture.bytes.readUInt16LE(directory + 12)).toBe(2);
    expect(fixture.bytes.readUInt16LE(directory + 14)).toBe(65_535);
    expect(fixture.entryOffsets).toHaveLength(65_537);
    expect(directory + 16 + 65_537 * 8).toBeLessThanOrEqual(
      fixture.bytes.length,
    );
    const path = join(root, "entries.exe");
    await writeFile(path, fixture.bytes);
    const entries = await inspect(path, {
      max_entries: MAX_INSPECT_PE_DIRECTORY_ENTRIES,
    });
    if (entries.ok) throw new Error("Expected entry-budget refusal");
    expect(entries.error).toBeInstanceOf(AnalysisResourceConstraintError);
    const entryError = entries.error as AnalysisResourceConstraintError;
    expect(entries.error).toMatchObject({
      resource: "capacity",
      reportedLimits: { max_entries: MAX_INSPECT_PE_DIRECTORY_ENTRIES },
      retryable: false,
    });
    expect(typeof entryError.remediationAction).toBe("string");
    expect(projectAnalysisError(entryError)).toMatchObject({
      remediation: { action: entryError.remediationAction },
    });
    expect(
      inspectPeResourcesInputSchema.safeParse({
        path,
        max_entries: MAX_INSPECT_PE_DIRECTORY_ENTRIES + 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a truncated resource table as malformed before applying the entry budget", async () => {
    const root = await createTestTempDirectory("rea-pe-truncated-entries-");
    const fixture = peResourceFixture();
    const directory = fixture.directoryOffsets[0];
    if (directory === undefined)
      throw new Error("Expected a resource directory");
    fixture.bytes.writeUInt16LE(0xffff, directory + 12);
    fixture.bytes.writeUInt16LE(2, directory + 14);
    const path = join(root, "truncated.exe");
    await writeFile(path, fixture.bytes);
    const result = await inspect(path, {
      max_entries: MAX_INSPECT_PE_DIRECTORY_ENTRIES,
    });
    if (result.ok) throw new Error("Expected malformed table refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisMalformedTargetError",
    });
  });
});

it("names the fixed PE metadata allowance instead of host memory", async () => {
  const root = await createTestTempDirectory("rea-pe-metadata-budget-");
  const path = join(root, "resource.exe");
  const name = "n".repeat(200);
  const resources = Array.from({ length: 5500 }, (_, index) => ({
    type: 10,
    name: `${name}${String(index).padStart(4, "0")}`,
    language: 1033,
    payload: Buffer.alloc(0),
  }));
  await writeFile(
    path,
    peResourceFixture(false, resources, 12 * 1024 * 1024).bytes,
  );
  const result = await inspect(path);
  if (result.ok) throw new Error("Expected a metadata refusal");
  const error = result.error as AnalysisResourceConstraintError;
  expect(error.resource).toBe("memory");
  expect(error.reportedLimits).toMatchObject({
    maximum_metadata_bytes: 8 * 1024 * 1024,
  });
  const projected = projectAnalysisError(error);
  expect(projected.retryable).toBe(false);
  expect(projected.details).toMatchObject({
    reported_limits: {
      boundary: "pe_resource_metadata_bytes",
      maximum: 8 * 1024 * 1024,
      maximum_metadata_bytes: 8 * 1024 * 1024,
    },
    refusal: {
      kind: "fixed_ceiling",
      allowance_kind: "parser",
      limit: 8 * 1024 * 1024,
      unit: "bytes",
    },
  });
});
