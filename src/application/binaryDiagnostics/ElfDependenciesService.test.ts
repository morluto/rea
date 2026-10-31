import { expect, it } from "vitest";
import { ElfDependenciesService } from "./ElfDependenciesService.js";
import { ELF_DEPENDENCIES_PROVIDER } from "../../domain/investigationProviders.js";
import type { ElfDependencies } from "../../domain/native/elfDependencies.js";
import { ok } from "../../domain/result.js";
import { parseEvidence } from "../../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

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

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new ElfDependenciesService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "program" });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it("records an empty PT_DYNAMIC inventory and its x86_64 architecture", async () => {
  const result = await new ElfDependenciesService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { format: "elf", architecture: "x86_64" },
    normalized_result: report,
  });
});

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
  const controller = new AbortController();
  const reason = { request: "late ELF dependency cancellation" };
  const service = new ElfDependenciesService({
    identity,
    inspect: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const late = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(late).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  if (late.ok) throw new Error("Expected late cancellation");
  expect(late.error).toBeInstanceOf(AnalysisCancelledError);
  expect(late.error.cause).toBe(reason);
  expect(parseEvidence(late.error.partialObservation)).toMatchObject({
    operation: "inspect_elf_dependencies",
    confidence: "observed",
    subject: { format: "elf", architecture: "x86_64" },
    normalized_result: report,
  });
});
