import { expectInvalidInspectionInputs } from "../../../tests/support/expectInvalidInspectionInputs.js";
import { parseEvidence } from "../../domain/evidence.js";
import { expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { DWARF_UNITS_PROVIDER } from "../../domain/investigationProviders.js";
import type { DwarfUnitsReport } from "../../domain/native/dwarfUnits.js";
import { ok } from "../../domain/result.js";
import { DwarfUnitsService } from "./DwarfUnitsService.js";

const identity = DWARF_UNITS_PROVIDER;
const report: DwarfUnitsReport = {
  artifact: {
    path: "/artifacts/program",
    sha256: "a".repeat(64),
    bytes: 128,
  },
  format: "elf",
  bits: 64,
  byte_order: "little",
  machine: 62,
  architecture: "x86_64",
  sections: [],
  debug_info: "absent",
  omissions: [
    {
      name: ".debug_info",
      reason: ".debug_info was not observed in this file",
    },
  ],
  units: [],
  total_units: 0,
  page: { offset: 0, limit: 32 },
  coverage: { status: "complete", reason: null },
  limitations: [
    "Child DIEs, types, line tables, and location expressions are not read.",
    "This file has no .debug_info section. That does not establish that a separate debug file is absent.",
  ],
};

it("rejects a relative path and extra arguments before reading", () =>
  expectInvalidInspectionInputs(
    report,
    "program",
    (inspect) => new DwarfUnitsService({ identity, inspect }),
  ));

it("records absent debug info for this file", async () => {
  const result = await new DwarfUnitsService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { identity: { format: "elf", architecture: "x86_64" } },
    normalized_result: report,
  });
});

it("rejects a report that disagrees with the requested page or file budget", async () => {
  const service = new DwarfUnitsService({
    identity,
    inspect: () =>
      Promise.resolve(ok({ ...report, page: { offset: 1, limit: 32 } })),
  });
  const paged = await service.inspect({ path: report.artifact.path });
  expect(paged.ok).toBe(false);
  if (!paged.ok) expect(paged.error).toBeInstanceOf(AnalysisOutputError);
  const oversized = await new DwarfUnitsService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ path: report.artifact.path, max_file_bytes: 64 });
  expect(oversized.ok).toBe(false);
  if (!oversized.ok)
    expect(oversized.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects a slice selection the caller did not request", async () => {
  const result = await new DwarfUnitsService({
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...report,
          format: "macho",
          architecture: "arm64",
          selected_slice: {
            kind: "macho-selected-image-v1",
            container: "fat",
            offset: 4096,
            byte_length: 128,
            cpu_type: 0x0100000c,
            cpu_subtype: 0,
            container_table_sha256: "b".repeat(64),
          },
        }),
      ),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("retains caller-selected parameters if cancellation arrives as the provider completes", async () => {
  const evidenceIds = [];
  for (const parameters of [
    { path: report.artifact.path },
    {
      path: report.artifact.path,
      offset: 0,
      limit: 32,
      max_file_bytes: 67_108_864,
    },
  ]) {
    const controller = new AbortController();
    const result = await new DwarfUnitsService({
      identity,
      inspect: () => {
        controller.abort();
        return Promise.resolve(ok(report));
      },
    }).inspect(parameters, { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected late cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    const evidence = parseEvidence(result.error.partialObservation);
    expect(evidence.parameters).toEqual(parameters);
    expect(evidence.normalized_result).toEqual(report);
    evidenceIds.push(evidence.evidence_id);
  }
  expect(evidenceIds[0]).not.toBe(evidenceIds[1]);
});

it("accepts an arm64e request answered by its arm64-family slice", async () => {
  const result = await new DwarfUnitsService({
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...report,
          format: "macho",
          architecture: "arm64",
          selected_slice: {
            kind: "macho-selected-image-v1",
            container: "fat",
            offset: 4096,
            byte_length: 128,
            cpu_type: 0x0100000c,
            cpu_subtype: 2,
            container_table_sha256: "b".repeat(64),
          },
        }),
      ),
  }).inspect({ path: report.artifact.path, architecture: "arm64e" });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    normalized_result: { architecture: "arm64" },
  });
});
