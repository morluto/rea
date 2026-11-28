import { z } from "zod";
import { firmwareVectorTableSchema } from "../firmware/firmwareVectorTable.js";
import { ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
  selectedViewPage,
} from "./analysisViewCoverage.js";
import { selectViewRows } from "./selectViewRows.js";

export const firmwareVectorTableViewRequestSchema = z.strictObject({
  kind: z.literal("firmware-vector-table"),
  collection: z.enum([
    "arm_entries",
    "riscv_slots",
    "shared_handler_groups",
    "anomalies",
  ]),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(1024).default(64),
});

const sourceIndex = { source_index: z.int().nonnegative() };

export const firmwareVectorTableViewItemsSchema = z.union([
  z.array(
    firmwareVectorTableSchema.shape.arm_entries.element.extend(sourceIndex),
  ),
  z.array(
    firmwareVectorTableSchema.shape.riscv_slots.element.extend(sourceIndex),
  ),
  z.array(
    firmwareVectorTableSchema.shape.shared_handler_groups.element.extend(
      sourceIndex,
    ),
  ),
  z.array(
    z.strictObject({
      anomaly: z.string(),
      ...sourceIndex,
    }),
  ),
]);

const {
  artifact,
  architecture,
  base_address,
  vector_table_offset,
  vector_table_address,
  vtor_aligned,
  examined_entries,
  table_file_range,
  coverage,
  initial_stack_pointer,
  reset_code_address,
  trap_entry_address,
  riscv_table_shape,
  svd_interrupts,
} = firmwareVectorTableSchema.shape;

const counts = {
  arm_entry_count: z.int().nonnegative(),
  active_arm_entry_count: z.int().nonnegative(),
  riscv_slot_count: z.int().nonnegative(),
  recognized_riscv_slot_count: z.int().nonnegative(),
  shared_handler_group_count: z.int().nonnegative(),
  anomaly_count: z.int().nonnegative(),
};

export const firmwareVectorTableSummarySchema = z.strictObject({
  artifact,
  architecture,
  base_address,
  vector_table_offset,
  vector_table_address,
  vtor_aligned,
  examined_entries,
  table_file_range,
  coverage,
  initial_stack_pointer,
  reset_code_address,
  trap_entry_address,
  riscv_table_shape,
  svd_interrupts,
  ...counts,
});

const readReport = createAnalysisViewResultReader(firmwareVectorTableSchema);

export const projectFirmwareVectorTableView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "firmware-vector-table")
    return invalidAnalysisView(
      "Firmware vector table Evidence supports summary and firmware-vector-table views.",
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof firmwareVectorTableViewRequestSchema>
  >(view, "summary", "firmware-vector-table");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const r = parsed.value;
  const context = {
    artifact: r.artifact,
    architecture: r.architecture,
    base_address: r.base_address,
    vector_table_offset: r.vector_table_offset,
    vector_table_address: r.vector_table_address,
    vtor_aligned: r.vtor_aligned,
    examined_entries: r.examined_entries,
    table_file_range: r.table_file_range,
    coverage: r.coverage,
    initial_stack_pointer: r.initial_stack_pointer,
    reset_code_address: r.reset_code_address,
    trap_entry_address: r.trap_entry_address,
    riscv_table_shape: r.riscv_table_shape,
    svd_interrupts: r.svd_interrupts,
    arm_entry_count: r.arm_entries.length,
    active_arm_entry_count: r.active_arm_entry_count,
    riscv_slot_count: r.riscv_slots.length,
    recognized_riscv_slot_count: r.recognized_riscv_slot_count,
    shared_handler_group_count: r.shared_handler_groups.length,
    anomaly_count: r.anomalies.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_firmware_vector_table" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: r.artifact.path, sha256: r.artifact.sha256 },
    limitations: boundedViewLimitations(parent, r.limitations),
    unknowns: [
      "Runtime VTOR or mtvec relocations, dynamic handler table rewrites, and interrupt-controller enable/priority state are not established from static table bytes alone.",
    ],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary: context,
      coverage: completeWithinViewCoverage(
        r.architecture === "riscv"
          ? r.riscv_slots.length
          : r.arm_entries.length,
      ),
    });

  const selected =
    view.collection === "arm_entries"
      ? selectViewRows(r.arm_entries, view, undefined, (row, source_index) => ({
          ...row,
          source_index,
        }))
      : view.collection === "riscv_slots"
        ? selectViewRows(
            r.riscv_slots,
            view,
            undefined,
            (row, source_index) => ({
              ...row,
              source_index,
            }),
          )
        : view.collection === "shared_handler_groups"
          ? selectViewRows(
              r.shared_handler_groups,
              view,
              undefined,
              (row, source_index) => ({
                ...row,
                source_index,
              }),
            )
          : selectViewRows(
              r.anomalies,
              view,
              undefined,
              (anomaly, source_index) => ({ anomaly, source_index }),
            );

  return ok({
    ...shared,
    kind: "firmware-vector-table" as const,
    view,
    vector_table: context,
    ...selectedViewPage(view.offset, selected),
  });
};
