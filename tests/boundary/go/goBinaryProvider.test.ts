import { realpath, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GoBinaryService } from "../../../src/application/go/GoBinaryService.js";
import { GoBinaryProvider } from "../../../src/go/GoBinaryProvider.js";
import { readStableArtifact } from "../../../src/artifacts/readStableArtifact.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  createGoBinaryDiagnosticFixtures,
  createGoBinaryFixture,
  createGoOverlappingElfFixture,
} from "../../fixtures/go/image.js";
import { createGoRodataStringFixture } from "../../fixtures/go/rodataStringImage.js";
import { CPU_ARM64, universalMacho } from "../../fixtures/universalMacho.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("distinguishes unsupported MZ carriers from damaged PE declarations", async () => {
  const root = await createTestTempDirectory("rea-go-mz-");
  for (const fixture of createGoBinaryDiagnosticFixtures()) {
    const path = join(root, `${fixture.name}.exe`);
    await writeFile(path, fixture.bytes);
    const result = await new GoBinaryProvider().inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(
        fixture.code === "unsupported_target"
          ? AnalysisUnsupportedTargetError
          : AnalysisInputError,
      );
  }
});

it.each([32, 64] as const)(
  "rejects advertised PE%d data directories outside the optional header",
  async (bits) => {
    const root = await createTestTempDirectory("rea-go-pe-directories-");
    const fixture = createGoBinaryFixture({ format: "pe", bits });
    fixture.bytes.writeUInt32LE(1, 152 + (bits === 64 ? 108 : 92));
    const path = join(root, `truncated-pe${String(bits)}.exe`);
    await writeFile(path, fixture.bytes);
    const result = await new GoBinaryProvider().inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisInputError);
      if (!(result.error instanceof AnalysisInputError)) throw result.error;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ reason: "invalid_format" }),
      );
    }
  },
);

it("preserves the actual build-info byte guard as a resource failure", async () => {
  const fixture = createGoBinaryFixture();
  fixture.bytes.set([0x81, 0x80, 0x40], fixture.headerOffset + 32);
  const root = await createTestTempDirectory("rea-go-resource-");
  const path = join(root, "oversized-metadata.elf");
  await writeFile(path, fixture.bytes);
  const result = await new GoBinaryProvider().inspect({ path });
  expect(result.ok).toBe(false);
  if (result.ok)
    throw new Error("Oversized embedded metadata must not succeed");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  if (!(result.error instanceof AnalysisResourceConstraintError))
    throw result.error;
  expect(result.error.reason).toContain(path);
  expect(result.error.reportedLimits).toEqual({
    boundary: "build-info",
    maximum_bytes: 1024 * 1024,
    parameter: "max_build_info_bytes",
    unit: "bytes",
  });
  const projected = projectAnalysisError(result.error);
  expect(projected.retryable).toBe(false);
  expect(projected.remediation.action).toContain(
    "Go build-info string allowance",
  );
  expect(projected.remediation.action).not.toMatch(/available host memory/u);
});

it("keeps the header-search budget distinct from a worker CPU limit", async () => {
  const root = await createTestTempDirectory("rea-go-search-");
  const path = join(root, "overlapping.elf");
  await writeFile(path, createGoOverlappingElfFixture());
  const result = await new GoBinaryProvider().inspect({ path });
  if (result.ok) throw new Error("Overlapping header search must be refused");
  const projected = projectAnalysisError(result.error);
  expect(projected).toMatchObject({
    retryable: false,
    details: {
      resource: "cpu",
      reported_limits: {
        boundary: "search",
        maximum_bytes: 256 * 1024 * 1024,
      },
    },
  });
  expect(projected.remediation.action).toContain("header-search allowance");
  expect(projected.remediation.action).not.toMatch(/observed signal/u);
});

it("reports unreadable ELF names alongside the no-record limitation", async () => {
  const bytes = createGoBinaryFixture({ omitBuildInfo: true }).bytes;
  const nameTableHeader = 256 + 64;
  bytes.writeBigUInt64LE(0x800n, nameTableHeader + 8);
  bytes.writeBigUInt64LE(24n, nameTableHeader + 32);
  bytes.writeUInt32LE(3, 768);
  const root = await createTestTempDirectory("rea-go-unknown-section-names-");
  const path = join(root, "unknown-names.elf");
  await writeFile(path, bytes);

  const result = await new GoBinaryProvider().inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.build_info).toBeNull();
  expect(result.value.limitations).toContain(
    "No recognized Go build-info record was found in the inspected image; absent metadata does not establish that the binary is not Go.",
  );
  expect(result.value.limitations).toContainEqual(
    expect.stringMatching(
      /section names.*unavailable.*compression type 3.*unsupported/iu,
    ),
  );
  expect(result.value).not.toHaveProperty("section_names_limitation");
});

it.skipIf(process.platform === "win32")(
  "rejects a symlink without replacing its selected file identity",
  async () => {
    const root = await createTestTempDirectory("rea-go-symlink-");
    const selected = join(root, "selected");
    const original = join(root, "original.elf");
    await writeFile(original, createGoBinaryFixture().bytes);
    await symlink(original, selected);
    const result = await new GoBinaryProvider().inspect({ path: selected });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisInputError);
      const projected = projectAnalysisError(result.error);
      expect(projected.remediation.action).toContain(original);
      expect(projected).not.toHaveProperty("recovery");
    }
  },
);

it.skipIf(process.platform === "win32")(
  "names the resolved target when refusing a selected symlink (#8714)",
  async () => {
    const root = await createTestTempDirectory("rea-go-symlink-target-");
    const selected = join(root, "cloudflared");
    const original = join(root, "original.elf");
    await writeFile(original, createGoBinaryFixture().bytes);
    await symlink(original, selected);
    const target = await realpath(original);
    const result = await new GoBinaryProvider().inspect({ path: selected });
    if (result.ok) throw new Error("expected the symlink to be refused");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    const projected = projectAnalysisError(result.error);
    expect(projected.details).toMatchObject({
      issues: [
        {
          path: ["path"],
          reason: "invalid_format",
          message: expect.stringContaining(target),
        },
      ],
    });
    const refusal: unknown = await readStableArtifact(selected, 1024).catch(
      (cause: unknown) => cause,
    );
    const recovery = (refusal as { userMessage?: string }).userMessage;
    expect(recovery).toContain(target);
    expect(projected.remediation.action).toBe(recovery);
    const retried = await new GoBinaryProvider().inspect({ path: target });
    if (!retried.ok) throw retried.error;
  },
);

it("reports a parse-complete GOPATH module text as unknown dependency coverage", async () => {
  const moduleText =
    "path\texample.com/tool/cmd/tool\n" +
    "build\t-compiler=gc\n" +
    "build\tGOOS=linux\n";
  const root = await createTestTempDirectory("rea-go-gopath-metadata-");
  const path = join(root, "application.elf");
  await writeFile(path, createGoBinaryFixture({ moduleText }).bytes);
  const result = await new GoBinaryProvider().inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.build_info?.module_text).toBe(moduleText);
  expect(result.value.build_info?.module).toMatchObject({
    path: "example.com/tool/cmd/tool",
    main: null,
    dependencies: [],
    complete: true,
    unparsed_lines: [],
  });
  expect(result.value.limitations.join(" ")).toContain(
    "Dependency coverage is unknown",
  );
});

it("keeps a module-mode build with no dependency records as an observed empty list", async () => {
  const moduleText =
    "path\texample.com/tool\n" +
    "mod\texample.com/tool\t(devel)\t\n" +
    "build\tGOOS=linux\n";
  const root = await createTestTempDirectory("rea-go-empty-module-deps-");
  const path = join(root, "application.elf");
  await writeFile(path, createGoBinaryFixture({ moduleText }).bytes);
  const result = await new GoBinaryProvider().inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.build_info?.module_text).toBe(moduleText);
  expect(result.value.build_info?.module).toMatchObject({
    main: { path: "example.com/tool", version: "(devel)" },
    dependencies: [],
    complete: true,
  });
  expect(result.value.limitations.join(" ")).not.toContain(
    "Dependency coverage is unknown",
  );
});

it("adjusts string_literals file offsets inside a universal Mach-O slice and records chained-fixup/truncation limitations", async () => {
  const rodata = Buffer.from(
    "ListResourceProvidersgenaihttps://example.invalid/v1",
    "utf8",
  );
  const thin = createGoRodataStringFixture({
    format: "macho",
    machoChainedFixups: true,
    rodata,
    headers: [
      { section: "data", offsetInSection: 0, ptr: 0x102000n, len: 21n },
      { section: "data", offsetInSection: 16, ptr: 0x102015n, len: 5n },
      { section: "data", offsetInSection: 32, ptr: 0x10201an, len: 26n },
    ],
  });
  const fat = universalMacho([
    { bytes: thin.bytes, cpuType: CPU_ARM64, cpuSubtype: 0 },
  ]);
  const sliceOffset = fat.slices[0]!.offset;
  const root = await createTestTempDirectory("rea-go-fat-strings-");
  const path = join(root, "universal-go");
  await writeFile(path, fat.bytes);

  const result = await new GoBinaryProvider().inspect({
    path,
    architecture: "arm64",
    include_string_literals: true,
    max_string_literals: 2,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.selected_slice?.offset).toBe(sliceOffset);
  expect(result.value.string_literals).toEqual({
    evidence_kind: "inferred",
    discovered_count: 3,
    aggregate_bytes: 26,
    max_items: 2,
    truncated: true,
    limits_reached: ["max_string_literals"],
    items: [
      {
        value: "ListResourceProviders",
        location: { offset: sliceOffset + thin.rodataOffset, bytes: 21 },
        first_header_offset: sliceOffset + thin.dataOffset,
        reference_count: 1,
      },
      {
        value: "genai",
        location: { offset: sliceOffset + thin.rodataOffset + 21, bytes: 5 },
        first_header_offset: sliceOffset + thin.dataOffset + 16,
        reference_count: 1,
      },
    ],
  });
  for (const item of result.value.string_literals?.items ?? []) {
    expect(
      fat.bytes
        .subarray(
          item.location.offset,
          item.location.offset + item.location.bytes,
        )
        .toString("utf8"),
    ).toBe(item.value);
  }
  const limitationsText = result.value.limitations.join(" ");
  expect(limitationsText).toContain("LC_DYLD_CHAINED_FIXUPS");
  expect(limitationsText).toContain("truncated");
});

it.each([
  ["max_input_bytes", 4095, 8192],
  ["max_report_bytes", 1, 16384],
  ["max_build_info_bytes", 1, 4096],
  ["max_header_search_bytes", 1, 4096],
] as const)(
  "recovers the same Go artifact after increasing %s",
  async (parameter, low, raised) => {
    const root = await createTestTempDirectory("rea-go-budget-recovery-");
    const path = join(root, "application.elf");
    await writeFile(path, createGoBinaryFixture().bytes);
    const service = new GoBinaryService(new GoBinaryProvider());
    try {
      const refused = await service.inspect({ path, [parameter]: low });
      if (refused.ok)
        throw new Error(
          "Selected low budget must refuse this complete artifact",
        );
      expect(projectAnalysisError(refused.error)).toMatchObject({
        code: "resource_constraint",
        details: { reported_limits: { parameter, unit: "bytes" } },
        remediation: { action: expect.stringContaining(parameter) },
      });
      const recovered = await service.inspect({ path, [parameter]: raised });
      if (!recovered.ok) throw recovered.error;
      expect(recovered.value.normalized_result).toMatchObject({
        artifact: { path, bytes: 4096 },
        build_info: { go_version: "go1.26.0" },
      });
      expect(recovered.value.parameters).toEqual({ path, [parameter]: raised });
    } finally {
      await service.close();
    }
  },
);

it.each([
  ["max_string_literals", 1],
  ["max_string_literal_bytes", 3],
  ["max_string_bytes", 5],
  ["max_string_header_scan_bytes", 16],
  ["max_string_candidates", 1],
] as const)(
  "identifies and recovers the exact inferred-string limit %s",
  async (parameter, low) => {
    const fixture = createGoRodataStringFixture({
      format: "elf",
      rodata: Buffer.from("alphabeta"),
      headers: [
        { section: "data", offsetInSection: 0, ptr: 0x102000n, len: 5n },
        { section: "data", offsetInSection: 16, ptr: 0x102005n, len: 4n },
      ],
    });
    const root = await createTestTempDirectory(
      "rea-go-string-budget-recovery-",
    );
    const path = join(root, "strings.elf");
    await writeFile(path, fixture.bytes);
    const service = new GoBinaryService(new GoBinaryProvider());
    try {
      const selected = { path, include_string_literals: true };
      const limited = await service.inspect({ ...selected, [parameter]: low });
      if (!limited.ok) throw limited.error;
      expect(limited.value.normalized_result).toMatchObject({
        string_literals: { truncated: true, limits_reached: [parameter] },
      });
      const recovered = await service.inspect({
        ...selected,
        [parameter]: 1048576,
      });
      if (!recovered.ok) throw recovered.error;
      expect(recovered.value.normalized_result).toMatchObject({
        string_literals: {
          truncated: false,
          items: [{ value: "alpha" }, { value: "beta" }],
        },
      });
      expect(recovered.value.subject).toEqual(limited.value.subject);
    } finally {
      await service.close();
    }
  },
);
