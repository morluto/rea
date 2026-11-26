import { expect, it } from "vitest";
import { projectAnalysisView } from "./analysisView.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { analysisViewRequestSchema } from "./analysisViewRequest.js";

const digest = (fill: string) => fill.repeat(64);
const file = (index: number, ffs_file?: unknown) => ({
  relative_path: `flash/FV@0x0/FFS-x@0x${index.toString(16)}/section-0.payload.bin`,
  path: `/out/flash/FV@0x0/FFS-x@0x${index.toString(16)}/section-0.payload.bin`,
  size: 16 + index,
  sha256: digest(index.toString(16)),
  original_file_range: { offset: 0x100 + index * 0x40, length: 16 + index },
  source_stream: null,
  source_range: { offset: 0x100 + index * 0x40, length: 16 + index },
  runtime_address: null,
  media_type: "application/vnd.microsoft.portable-executable",
  source: "raw-section",
  parent_logical_path: `flash/FV@0x0/FFS:x@0x${index.toString(16)}`,
  ...(ffs_file === undefined ? {} : { ffs_file }),
});
const extraction = (files: readonly unknown[]) => ({
  parser: { name: "rea-uefi", version: "1.0.0" },
  selection: {
    offset: 0,
    length: 4096,
    source_stream: null,
    target_kind: "whole-image",
  },
  output_directory: "/out",
  coverage: "complete",
  files,
  derivations: [],
  extraction_gaps: [],
  diagnostics: "1 volumes mapped",
  published_bytes: 0,
});
const project = (report: unknown, view: unknown) => {
  const parent: AnalysisViewParent = {
    predicateType: "rea.analysis",
    evidenceId: `ev_${digest("b")}`,
    operation: "extract_uefi_firmware",
    normalizedResult: report,
    limitations: [],
  };
  const result = projectAnalysisView(
    parent,
    analysisViewRequestSchema.parse(view),
  );
  if (!result.ok) throw result.error;
  return result.value;
};

it("reads extraction Evidence saved before files recorded their FFS owner", () => {
  const report = extraction([file(0), file(1)]);
  expect(project(report, { kind: "summary" })).toMatchObject({
    summary: { file_count: 2, files_preview: { omitted: 0 } },
  });
  expect(
    project(report, {
      kind: "uefi-extraction",
      collection: "files",
      order: "size-desc",
    }),
  ).toMatchObject({
    items: [{ source_index: 1 }, { source_index: 0 }],
    coverage: { total: 2 },
  });
  // An unrecorded owner is unknown, so it matches no owner filter.
  expect(
    project(report, {
      kind: "uefi-extraction",
      collection: "files",
      ffs_type_names: ["driver"],
    }),
  ).toMatchObject({ items: [], coverage: { total: 0 } });
});

it("accepts owner filters longer than 64 values", () => {
  const owner = {
    guid: "9e21fd93-9c72-4c15-8c4b-e77f9db8d4d2",
    ui_string: "DemoDxe",
    type_name: "driver",
    logical_path: "flash/FV@0x0/FFS:9e21fd93-9c72-4c15-8c4b-e77f9db8d4d2@0x48",
  };
  const names = Array.from({ length: 100 }, (_, i) => `Other${String(i)}`);
  expect(
    project(extraction([file(0, owner), file(1, null)]), {
      kind: "uefi-extraction",
      collection: "files",
      ffs_ui_names: [...names, "DemoDxe"],
    }),
  ).toMatchObject({ items: [{ source_index: 0 }], coverage: { total: 1 } });
});
