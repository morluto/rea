import { expectInvalidInspectionInputs } from "../../../tests/support/expectInvalidInspectionInputs.js";
import { lateCancellationEvidence } from "../../../tests/support/lateCancellationEvidence.js";
import { expect, it } from "vitest";
import { ElfDependenciesService } from "./ElfDependenciesService.js";
import { ELF_DEPENDENCIES_PROVIDER } from "../../domain/investigationProviders.js";
import type { ElfDependencies } from "../../domain/native/elfDependencies.js";
import { ok } from "../../domain/result.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";

const identity = ELF_DEPENDENCIES_PROVIDER;
const digest = "a".repeat(64);
const report: ElfDependencies = {
  artifact: { path: "/artifacts/program", sha256: digest, bytes: 512 },
  format: "elf64",
  byte_order: "little",
  machine: 62,
  architecture: "amd64",
  type: 3,
  type_name: "shared",
  interpreter: { status: "absent", path: null, location: null },
  dynamic: {
    status: "absent",
    location: null,
    soname: null,
    rpath: null,
    runpath: null,
    flags: null,
    flags_1: null,
  },
  needed: [],
  version_requirements: { status: "absent", location: null, files: [] },
  version_definitions: { status: "absent", location: null, names: [] },
  derived_version_maxima: [],
  imports: [],
  coverage: {
    status: "complete",
    reason: null,
    examined_needed: 0,
    examined_versions: 0,
    examined_imports: 0,
  },
  issues: [],
  limitations: [
    "No PT_DYNAMIC program header was declared. That is an observed empty load-time dependency inventory, not proof another overlay or container carried dynamic linking metadata.",
  ],
};

it("rejects a relative path and extra arguments before reading", () =>
  expectInvalidInspectionInputs(
    report,
    "program",
    (inspect) => new ElfDependenciesService({ identity, inspect }),
  ));

it("records an empty PT_DYNAMIC inventory and its x86_64 architecture", async () => {
  const result = await new ElfDependenciesService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: {
      identity: {
        kind: "file",
        format: "elf",
        architecture: "x86_64",
        sha256: report.artifact.sha256,
      },
      local_path: report.artifact.path,
    },
    normalized_result: report,
  });
});

it.each([undefined, 1024, 2])(
  "preserves caller budget selection (%s) separately from execution defaults",
  async (maxNeeded) => {
    let resolved: number | undefined;
    const rawInput = {
      path: report.artifact.path,
      ...(maxNeeded === undefined ? {} : { max_needed: maxNeeded }),
    };
    const result = await new ElfDependenciesService({
      identity,
      inspect: (input) => {
        resolved = input.max_needed;
        return Promise.resolve(ok(report));
      },
    }).inspect(rawInput);
    if (!result.ok) throw result.error;
    expect(resolved).toBe(maxNeeded ?? 1024);
    expect(result.value.parameters).toEqual(rawInput);
  },
);

it("rejects a report whose needed coverage does not match retained rows", async () => {
  const result = await new ElfDependenciesService({
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...report,
          coverage: { ...report.coverage, examined_needed: 1 },
        }),
      ),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects complete coverage that still retains table issues", async () => {
  const result = await new ElfDependenciesService({
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...report,
          issues: [
            {
              code: "name_unreadable",
              location: "DT_SONAME",
              message: "unterminated",
            },
          ],
        }),
      ),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("retains a completed observation if the caller cancels while the provider completes", async () => {
  const evidence = await lateCancellationEvidence(
    report,
    "late ELF dependency cancellation",
    (inspect) => new ElfDependenciesService({ identity, inspect }),
  );
  expect(evidence).toMatchObject({
    operation: "inspect_elf_dependencies",
    confidence: "observed",
    subject: {
      identity: {
        kind: "file",
        format: "elf",
        architecture: "x86_64",
        sha256: report.artifact.sha256,
      },
      local_path: report.artifact.path,
    },
    normalized_result: report,
  });
});
