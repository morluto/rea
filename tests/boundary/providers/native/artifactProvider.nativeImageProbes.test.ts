import { projectCliAnalysisResult } from "../../../../src/cli/projectCliAnalysisResult.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { peWithoutImportTableFixture } from "../../../fixtures/binaryDiagnostics/peImports.js";
import { buildGodotPck, pckU64 } from "../../../fixtures/godotPck.js";
import {
  minimalElfImage,
  minimalMachoImage,
} from "../../../fixtures/nativeHeaders.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  CPU_ARM64,
  CPU_X86_64,
  universalMacho,
} from "../../../fixtures/universalMacho.js";
import { createDirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import { buildManagedPeFixture } from "../../../../src/dotnet/ManagedPe.fixture.js";
import { artifactInspectionResultSchema } from "../../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";

const { runProviderAnalysis } = createDirectAnalysis({});

const PE_STATIC_READERS = [
  "inspect_pe_imports",
  "inspect_native_exports",
  "inspect_pe_load_config",
  "inspect_pe_resources",
  "inspect_binary_hardening",
  "audit_release_exposure",
];

const inspect = async (name: string, bytes: Buffer) => {
  const directory = await createTestTempDirectory("rea-native-probes-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  const evidence = parseEvidence(
    await runProviderAnalysis(path, "inspect_artifact", {}).then(
      projectCliAnalysisResult,
    ),
  );
  const inspection = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );
  expect(
    inspection.unexplored_branches.map(({ next_probe }) => next_probe),
  ).toEqual(inspection.next_probes);
  const inventory = inspection.substeps[0]!.evidence.normalized_result;
  const root = inventory.nodes.find(
    ({ artifact_id }) => artifact_id === inventory.manifest.root_artifact_id,
  );
  return {
    format: inspection.subject.root_format,
    subject: evidence.subject?.identity,
    rootNode: [root?.format, root?.architecture],
    hypotheses: inspection.hypotheses.map(({ statement }) => statement),
    probes: inspection.next_probes.map(({ operation, authority }) => ({
      operation,
      authority,
    })),
  };
};

const operations = (probes: readonly { readonly operation: string }[]) =>
  probes.map(({ operation }) => operation);

it("names an ARM64 PE's architecture and its static readers before a deep provider", async () => {
  const bytes = peWithoutImportTableFixture(64);
  bytes.writeUInt16LE(0xaa64, bytes.readUInt32LE(0x3c) + 4);

  const inspected = await inspect("native.dll", bytes);

  expect(inspected).toMatchObject({
    format: "pe",
    subject: { kind: "file", format: "pe", architecture: "arm64" },
    rootNode: ["pe", "arm64"],
    hypotheses: [],
  });
  // No CLI header is declared, so managed inspection is not proposed.
  expect(operations(inspected.probes)).toEqual([
    ...PE_STATIC_READERS,
    "open_binary",
  ]);
  expect(
    inspected.probes.filter(({ authority }) => authority !== "artifact-bytes"),
  ).toEqual([
    { operation: "open_binary", authority: "native-analysis-provider" },
  ]);
});

it("leads with managed inspection only when the PE declares a CLI header", async () => {
  const inspected = await inspect("Fixture.dll", buildManagedPeFixture());

  expect(inspected.subject).toMatchObject({ architecture: "x86" });
  expect(operations(inspected.probes)).toEqual([
    "inspect_managed_artifact",
    ...PE_STATIC_READERS,
    "open_binary",
  ]);
});

it("names each archived image's header architecture and keeps an undecoded machine unknown", async () => {
  const arm64 = peWithoutImportTableFixture(64);
  arm64.writeUInt16LE(0xaa64, arm64.readUInt32LE(0x3c) + 4);
  // IMAGE_FILE_MACHINE_LOONGARCH64 frames as PE, but REA does not decode it.
  const loong = peWithoutImportTableFixture(64);
  loong.writeUInt16LE(0x6264, loong.readUInt32LE(0x3c) + 4);
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, bytes] of [
    ["arm64.dll", arm64],
    ["loong.dll", loong],
    ["tool", minimalElfImage()],
  ] as const)
    await writer.add(name, new Uint8ArrayReader(bytes));
  const directory = await createTestTempDirectory("rea-native-probes-");
  const path = join(directory, "images.zip");
  await writeFile(path, await writer.close());

  const evidence = parseEvidence(
    await runProviderAnalysis(path, "inspect_artifact", {}).then(
      projectCliAnalysisResult,
    ),
  );
  const inventory = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  ).substeps[0]!.evidence.normalized_result;
  const architectures = Object.fromEntries(
    inventory.occurrences
      .filter(({ logical_path }) => logical_path !== ".")
      .map(({ logical_path, artifact_id }) => [
        logical_path,
        inventory.nodes.find((node) => node.artifact_id === artifact_id),
      ])
      .map(([path, node]) => [
        path,
        typeof node === "object" ? [node.format, node.architecture] : node,
      ]),
  );
  expect(architectures).toEqual({
    "arm64.dll": ["pe", "arm64"],
    "loong.dll": ["pe", null],
    tool: ["elf", "x86_64"],
  });
});

it("proposes ELF static readers with the header architecture", async () => {
  const inspected = await inspect("tool", minimalElfImage());

  expect(inspected).toMatchObject({
    format: "elf",
    subject: { architecture: "x86_64" },
    rootNode: ["elf", "x86_64"],
  });
  expect(operations(inspected.probes)).toEqual([
    "inspect_elf_dependencies",
    "inspect_native_exports",
    "inspect_binary_hardening",
    "audit_release_exposure",
    "open_binary",
  ]);
});

it("proposes Mach-O static readers with the header architecture", async () => {
  const inspected = await inspect("tool", minimalMachoImage());

  expect(inspected).toMatchObject({
    format: "mach-o",
    subject: { architecture: "arm64" },
    rootNode: ["mach-o", "arm64"],
  });
  expect(operations(inspected.probes)).toEqual([
    "inspect_macho",
    "inspect_signature",
    "inspect_binary_hardening",
    "audit_release_exposure",
    "open_binary",
  ]);
});

it("names each universal slice's architecture and the selected slice in the subject", async () => {
  const universal = universalMacho([
    { bytes: minimalMachoImage(), cpuType: CPU_X86_64, cpuSubtype: 3 },
    { bytes: minimalMachoImage(), cpuType: CPU_ARM64, cpuSubtype: 0 },
  ]);
  const directory = await createTestTempDirectory("rea-native-probes-");
  const path = join(directory, "tool");
  await writeFile(path, universal.bytes);

  const evidence = parseEvidence(
    await runProviderAnalysis(path, "inspect_artifact", {}).then(
      projectCliAnalysisResult,
    ),
  );
  const inspection = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );
  const inventory = inspection.substeps[0]!.evidence.normalized_result;
  const nodeOf = (artifactId: string | null) =>
    inventory.nodes.find(({ artifact_id }) => artifact_id === artifactId);
  // The container holds several CPU families, so its own node names none;
  // each slice node names its header's.
  expect(
    inventory.occurrences
      .map(({ entry_kind, artifact_id }) => [
        entry_kind,
        nodeOf(artifact_id)?.architecture,
      ])
      .sort(),
  ).toEqual([
    ["file", null],
    ["slice", "arm64"],
    ["slice", "x86_64"],
  ]);
  const selected = process.arch === "arm64" ? "arm64" : "x86_64";
  expect(evidence.subject?.identity).toMatchObject({
    format: "mach-o-universal",
    architecture: selected,
  });
  expect(operations(inspection.next_probes)).toEqual([
    "inspect_macho",
    "inspect_signature",
    "inspect_binary_hardening",
    "audit_release_exposure",
    "open_binary",
  ]);
});

it("keeps the carrier's architecture on its bytes, not on the embedded package subject", async () => {
  const pack = buildGodotPck(3, [
    { path: "res://main.gd", data: "extends Node\n" },
  ]);
  const bytes = Buffer.concat([
    minimalElfImage(256),
    pack,
    pckU64(pack.length),
    Buffer.from("GDPC"),
  ]);

  // The subject names the package inventory read; the root node names the
  // stored bytes, which are the x86-64 ELF carrier.
  expect(await inspect("engine", bytes)).toMatchObject({
    format: "godot-pck",
    subject: { format: "godot-pck", architecture: null },
    rootNode: ["elf", "x86_64"],
  });
});
