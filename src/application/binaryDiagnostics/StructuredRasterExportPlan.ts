import { walkRasterLogicalSegments } from "../../domain/rasterLogicalSegments.js";
import { selectRasterRegistries } from "./RasterRenderingSelection.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { StructuredRasterExportInput } from "../../domain/native/structuredRasterExport.js";
import type { SafeOutputFile } from "../../resources/index.js";
import type { prepareStructuredRasterAnalysis } from "./StructuredRasterAnalysis.js";
import type {
  RasterRenderLayout,
  RasterRendered,
} from "./RasterResourceRendering.js";
import type { RasterRegistryCandidate } from "../../domain/rasterRegistryFamily.js";
import type {
  StructuredRasterRange,
  StructuredRasterResource,
} from "../../domain/structuredRasterDiscovery.js";
import {
  RASTER_EXPORT_OPERATION,
  RASTER_EXPORT_LIMITS,
  rasterExportCapacity,
} from "./RasterExportPublication.js";
export type Prepared = ReturnType<typeof prepareStructuredRasterAnalysis>;
export const invalid = (field: string, message: string) =>
  new AnalysisInputError(RASTER_EXPORT_OPERATION, undefined, [
    { path: [field], reason: "invalid_value", message },
  ]);
/** Full segment-table references, never the bounded inspection projection. */
export function reference(prepared: Prepared, range: StructuredRasterRange) {
  const offset = range.offset + prepared.logical.logicalBase;
  const traversal = walkRasterLogicalSegments(
    prepared.logical.segments,
    offset,
    range.length,
  );
  return {
    offset,
    length: range.length,
    first_segment: traversal.firstSegment,
    segment_count: traversal.segmentCount,
    complete: traversal.complete,
  };
}
export interface ExportOutcome {
  descriptor_offset: number;
  width: number;
  height: number;
  status: "exported" | "skipped";
  reason?: string;
  /** Admitted interpretations withheld by ambiguity policy, not executable export plans. */
  alternatives?: ExportAlternative[];
  hypothesis?: { bits_per_pixel: number; offset_unit: number };
  descriptor: ReturnType<typeof reference>;
  payload?: ReturnType<typeof reference>;
  lookup?: ReturnType<typeof reference>;
  palette?: ReturnType<typeof reference>;
  registry?: {
    range: ReturnType<typeof reference>;
    pointer_bias: number;
    binding_status: "unique" | "conflicting";
  };
  provenance: "inferred" | "profile-declared";
  discovery_status: "unique" | "ambiguous" | "unresolved";
  files: { raw?: SafeOutputFile; png?: SafeOutputFile };
  interpretation?: RasterRendered["interpretation"];
}
export type ExportAlternative = Required<
  Pick<ExportOutcome, "hypothesis" | "payload" | "provenance">
> &
  Pick<ExportOutcome, "lookup" | "palette" | "registry"> & {
    evidence?: Pick<
      StructuredRasterResource["hypotheses"][number],
      "matches" | "consistency" | "stride" | "covered"
    >;
  };
/** Keep the same projected facts as an exportable candidate, without granting write eligibility. */
function alternativeEvidence(
  prepared: Prepared,
  plan: Plan,
  payload: StructuredRasterRange,
): ExportAlternative {
  const { hypothesis, provenance, lookup, palette, registry } = plan.outcome;
  return {
    hypothesis: hypothesis!,
    provenance,
    payload: reference(prepared, payload),
    ...(lookup ? { lookup } : {}),
    ...(palette ? { palette } : {}),
    ...(registry ? { registry } : {}),
  };
}
export interface Plan {
  outcome: ExportOutcome;
  layout?: RasterRenderLayout;
  payload?: StructuredRasterRange;
  registry?: RasterRegistryCandidate;
}
export function selectExportRegistries(
  prepared: Prepared,
  input: StructuredRasterExportInput,
) {
  const registries = prepared.family?.registries ?? [];
  if (!input.registry_selection) return registries;
  const chosen = selectRasterRegistries(
    registries,
    prepared.logical.logicalBase,
    input.registry_selection,
  );
  if (chosen.length !== 1)
    throw invalid(
      "registry_selection",
      "Registry selection must exactly identify one admitted registry alternative.",
    );
  return chosen;
}
function validateSelections(
  prepared: Prepared,
  input: StructuredRasterExportInput,
  registries: RasterRegistryCandidate[],
) {
  const resources = prepared.report.tables.flatMap((t) => t.resources),
    seen = new Set<string>();
  for (const selection of input.selections ?? []) {
    const key = JSON.stringify(selection);
    if (seen.has(key))
      throw invalid("selections", "Duplicate resource selection.");
    seen.add(key);
    const r = resources.find(
      (r) =>
        r.descriptorOffset + prepared.logical.logicalBase ===
        selection.descriptor_offset,
    );
    if (!r)
      throw invalid(
        "selections",
        "Descriptor selection is not an admitted resource.",
      );
    if (selection.hypothesis) {
      const h = selection.hypothesis;
      const alternatives = prepared.family
        ? registries.flatMap((c) =>
            c.bindings.filter((b) => b.descriptorOffset === r.descriptorOffset),
          )
        : r.hypotheses;
      if (
        !alternatives.some(
          (a) =>
            a.bitsPerPixel === h.bits_per_pixel &&
            a.offsetUnit === h.offset_unit,
        )
      )
        throw invalid(
          "selections",
          "Hypothesis selection is not an admitted alternative.",
        );
    }
  }
}
function genericPlan(
  r: StructuredRasterResource,
  h: StructuredRasterResource["hypotheses"][number],
  outcome: ExportOutcome,
): Plan {
  const base = {
    outcome: {
      ...outcome,
      files: {},
      hypothesis: { bits_per_pixel: h.bitsPerPixel, offset_unit: h.offsetUnit },
    },
    payload: h.payloadRange,
  };
  if (!h.covered)
    return {
      outcome: {
        ...base.outcome,
        reason: "Payload is not fully covered by admitted source mappings.",
      },
    };
  if (![1, 2, 4, 8].includes(h.bitsPerPixel))
    return {
      ...base,
      outcome: {
        ...base.outcome,
        reason:
          "No supported color layout is inferred for this generic hypothesis.",
      },
    };
  return {
    ...base,
    layout: {
      width: r.width,
      height: r.height,
      layout: `indexed${h.bitsPerPixel}` as RasterRenderLayout["layout"],
      bitsPerPixel: h.bitsPerPixel as 1 | 2 | 4 | 8,
      stride: h.stride,
      payloadRange: h.payloadRange,
      lookupRange: null,
      rowOrder: "top-down",
      bitOrder: "msb-first",
      provenance: "inferred",
    },
  };
}
function familyPlan(
  prepared: Prepared,
  input: StructuredRasterExportInput,
  outcome: ExportOutcome,
  c: RasterRegistryCandidate,
  b: RasterRegistryCandidate["bindings"][number],
): Plan {
  const selected: ExportOutcome = {
    ...outcome,
    files: {},
    provenance: "profile-declared",
    hypothesis: {
      bits_per_pixel: b.bitsPerPixel,
      offset_unit: b.offsetUnit,
    },
    registry: {
      range: reference(prepared, c.range),
      pointer_bias: c.pointerBias - prepared.logical.logicalBase,
      binding_status: c.bindingStatus,
    },
  };
  if (b.lookupRange) selected.lookup = reference(prepared, b.lookupRange);
  if (input.color_policy.kind === "record12-lut-registry") {
    const slot = input.color_policy.theme_slot;
    const palette = c.palettes.find((p) => p.slot === slot);
    if (palette) selected.palette = reference(prepared, palette.range);
  }
  return {
    outcome: selected,
    layout: b,
    payload: b.payloadRange,
    registry: c,
  };
}
/** Rebuilt orchestration from admitted domain facts, not previous response pagination. */
export function planExport(
  prepared: Prepared,
  input: StructuredRasterExportInput,
): Plan[] {
  if (input.resource_family !== "generic" && prepared.family === undefined)
    throw invalid(
      "resource_family",
      "Requested family analysis is unavailable; generic inference is not a substitute.",
    );
  const registries = selectExportRegistries(prepared, input);
  validateSelections(prepared, input, registries);
  const plans: Plan[] = [];
  const push = (plan: Plan) => {
    if (plans.length >= RASTER_EXPORT_LIMITS.resource_outcomes)
      throw rasterExportCapacity(
        "Expanded raster resource outcome allowance exceeded.",
        "resource_outcomes",
      );
    plans.push(plan);
  };
  for (const r of prepared.report.tables.flatMap((t) => t.resources)) {
    const offset = r.descriptorOffset + prepared.logical.logicalBase,
      selections = input.selections?.filter(
        (s) => s.descriptor_offset === offset,
      );
    if (input.selections && !selections?.length) continue;
    const explicit =
      selections?.flatMap((s) => (s.hypothesis ? [s.hypothesis] : [])) ?? [];
    const matches = (a: { bitsPerPixel: number; offsetUnit: number }) =>
      explicit.length === 0 ||
      explicit.some(
        (h) =>
          h.bits_per_pixel === a.bitsPerPixel && h.offset_unit === a.offsetUnit,
      );
    const outcome: ExportOutcome = {
      descriptor_offset: offset,
      width: r.width,
      height: r.height,
      status: "skipped",
      descriptor: reference(prepared, {
        offset: r.descriptorOffset,
        length: prepared.report.grammar.recordStride,
      }),
      provenance: "inferred",
      discovery_status: r.status,
      files: {},
    };
    if (prepared.family) {
      const alternatives = registries.flatMap((c) =>
        c.bindings
          .filter(
            (b) => b.descriptorOffset === r.descriptorOffset && matches(b),
          )
          .map((b) => ({ c, b })),
      );
      if (
        !alternatives.length ||
        (alternatives.length > 1 && input.ambiguity === "skip")
      ) {
        push({
          outcome: {
            ...outcome,
            reason: alternatives.length
              ? "Multiple registry alternatives; select a registry or ambiguity=all."
              : "No admitted family binding.",
            alternatives: alternatives.map(({ c, b }) =>
              alternativeEvidence(
                prepared,
                familyPlan(prepared, input, outcome, c, b),
                b.payloadRange,
              ),
            ),
          },
        });
        continue;
      }
      for (const { c, b } of alternatives)
        push(familyPlan(prepared, input, outcome, c, b));
    } else {
      const hypotheses = r.hypotheses.filter(matches);
      if (
        !hypotheses.length ||
        (hypotheses.length > 1 &&
          explicit.length === 0 &&
          input.ambiguity === "skip")
      ) {
        push({
          outcome: {
            ...outcome,
            reason: hypotheses.length
              ? "Ambiguous generic layout; choose an admitted hypothesis or ambiguity=all."
              : "No admitted generic layout.",
            alternatives: hypotheses.map((h) => ({
              ...alternativeEvidence(
                prepared,
                genericPlan(r, h, outcome),
                h.payloadRange,
              ),
              evidence: {
                matches: h.matches,
                consistency: h.consistency,
                stride: h.stride,
                covered: h.covered,
              },
            })),
          },
        });
        continue;
      }
      for (const h of hypotheses) push(genericPlan(r, h, outcome));
    }
  }
  for (const plan of plans)
    if (plan.payload) plan.outcome.payload = reference(prepared, plan.payload);
  return plans;
}
