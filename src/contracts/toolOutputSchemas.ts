import { z } from "zod";
import { evidenceSchema } from "../domain/evidence.js";
import { processCaptureSchema } from "../domain/processCapture.js";
import { evidenceBundleSchema } from "../domain/evidenceBundle.js";

const resultOf = (schema: z.ZodType) =>
  evidenceSchema.omit({ result: true }).extend({ result: schema });
const lifecycleResultOf = (schema: z.ZodType) => z.object({ result: schema });
const comparisonStatus = z.enum([
  "unchanged",
  "added",
  "removed",
  "changed",
  "truncated",
  "unknown",
]);
const nullableText = z.string().nullable();
const addressList = z.array(z.string());
const addressedEntry = z.object({ address: z.string(), name: z.string() });
const procedureIdentity = z.object({ address: z.string(), name: z.string() });
const containingProcedureResolution = z.discriminatedUnion("found", [
  z.object({
    query_address: z.string(),
    found: z.literal(true),
    procedure: procedureIdentity,
  }),
  z.object({
    query_address: z.string(),
    found: z.literal(false),
    procedure: z.null(),
    reason: z.enum(["outside_segments", "not_in_procedure"]),
  }),
]);
const unavailable = z.object({
  available: z.literal(false),
  reason: z.string(),
});
const bounded = (item: z.ZodType) =>
  z.object({
    items: z.array(item),
    total: z.number().int().min(0).nullable(),
    returned: z.number().int().min(0),
    truncated: z.boolean(),
    next_offset: z.number().int().min(0).nullable(),
  });
const pageOutput = z.object({
  items: z.array(z.object({ address: z.string(), value: z.string() })),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  total: z.number().int().min(0),
  next_offset: z.number().int().min(0).nullable(),
  has_more: z.boolean(),
});
const segmentOutput = resultOf(
  z.array(
    z.object({
      name: z.string(),
      start: z.string(),
      end: z.string(),
      writable: z.boolean().nullable(),
      executable: z.boolean().nullable(),
      permissions: unavailable,
      sections: z.array(
        z.object({ name: z.string(), start: z.string(), end: z.string() }),
      ),
    }),
  ),
);
const procedureInfoOutput = resultOf(
  z.object({
    name: z.string(),
    entrypoint: z.string(),
    basicblock_count: z.number().int().min(0),
    length: z.number().min(0),
    signature: nullableText,
    locals: z.array(z.json()),
  }),
);
const symbolDiscoveryOutput = (property: "classes" | "protocols") =>
  resultOf(
    z.object({
      count: z.number().int().min(0),
      [property]: z.array(addressedEntry),
    }),
  );
const graphNode = z.union([
  z.object({ address: z.string(), calls: z.array(z.string()) }),
  z.object({ address: z.string(), error: z.string() }),
]);
const referenceEdge = z.object({
  source_address: z.string(),
  target_address: z.string(),
  source_procedure: procedureIdentity.nullable(),
  target_procedure: procedureIdentity.nullable(),
  kind: unavailable,
});
const referencedValue = z.object({
  address: z.string(),
  value: z.string(),
  source_address: z.string(),
});
const functionDossierOutput = resultOf(
  z.object({
    procedure: z.object({
      address: z.string(),
      name: z.string(),
      signature: nullableText,
      locals: z.array(z.json()),
    }),
    pseudocode: z.object({
      text: z.string(),
      total_chars: z.number().int().min(0),
      returned_chars: z.number().int().min(0),
      truncated: z.boolean(),
      next_offset: z.number().int().min(0).nullable(),
    }),
    assembly: bounded(z.string()),
    comments: bounded(
      z.object({
        address: z.string(),
        kind: z.enum(["comment", "inline"]),
        text: z.string(),
      }),
    ),
    callers: bounded(procedureIdentity),
    callees: bounded(procedureIdentity),
    incoming_references: bounded(referenceEdge),
    outgoing_references: bounded(referenceEdge),
    referenced_strings: bounded(referencedValue),
    referenced_names: bounded(referencedValue),
    basic_blocks: bounded(
      z.object({
        start: z.string(),
        end: z.string(),
        successors: z.array(z.string()),
      }),
    ),
    instruction_scan: z.object({
      scanned: z.number().int().min(0),
      truncated: z.boolean(),
    }),
  }),
);

/** Exact structured-content schemas for the direct Hopper operations. */
export const officialOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  address_name: resultOf(nullableText),
  comment: resultOf(nullableText),
  current_address: resultOf(z.string()),
  current_procedure: resultOf(z.string()),
  current_document: resultOf(z.string()),
  goto_address: resultOf(z.string()),
  inline_comment: resultOf(nullableText),
  list_bookmarks: resultOf(z.array(addressedEntry)),
  list_documents: resultOf(z.array(z.string())),
  list_names: resultOf(pageOutput),
  list_procedures: resultOf(pageOutput),
  list_segments: segmentOutput,
  list_strings: resultOf(pageOutput),
  next_address: resultOf(z.string()),
  prev_address: resultOf(z.string()),
  procedure_address: resultOf(z.string()),
  procedure_assembly: resultOf(z.string()),
  procedure_callees: resultOf(addressList),
  procedure_callers: resultOf(addressList),
  procedure_info: procedureInfoOutput,
  procedure_references: resultOf(
    z.object({
      procedure: procedureIdentity,
      direction: z.enum(["incoming", "outgoing"]),
      references: bounded(
        z.object({
          source_address: z.string(),
          target_address: z.string(),
          source_procedure: procedureIdentity.nullable(),
          target_procedure: procedureIdentity.nullable(),
          kind: unavailable,
        }),
      ),
      instructions_scanned: z.number().int().min(0),
      instruction_scan_truncated: z.boolean(),
    }),
  ),
  procedure_pseudo_code: resultOf(nullableText),
  resolve_containing_procedure: resultOf(containingProcedureResolution),
  search_procedures: resultOf(z.record(z.string(), z.string())),
  search_strings: resultOf(z.record(z.string(), z.string())),
  set_address_name: resultOf(z.boolean()),
  set_addresses_names: resultOf(z.record(z.string(), z.boolean())),
  set_bookmark: resultOf(z.boolean()),
  set_comment: resultOf(z.boolean()),
  set_current_document: resultOf(z.string()),
  set_inline_comment: resultOf(z.boolean()),
  unset_bookmark: resultOf(z.boolean()),
  xrefs: resultOf(addressList),
};

/** Exact structured-content schemas for composed analysis workflows. */
export const enhancedOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  swift_classes: symbolDiscoveryOutput("classes"),
  get_objc_classes: symbolDiscoveryOutput("classes"),
  get_objc_protocols: symbolDiscoveryOutput("protocols"),
  batch_decompile: resultOf(
    z.union([
      z.object({ error: z.literal("No addresses provided") }),
      z.record(z.string(), z.string()),
    ]),
  ),
  get_call_graph: resultOf(z.record(z.string(), z.array(graphNode))),
  analyze_swift_types: resultOf(
    z.object({
      total: z.number().int().min(0),
      categories: z.record(
        z.string(),
        z.object({
          count: z.number().int().min(0),
          items: z.array(addressedEntry),
        }),
      ),
    }),
  ),
  find_xrefs_to_name: resultOf(
    z.union([
      z.object({ xrefs: addressList }),
      z.object({ error: z.string() }),
    ]),
  ),
  binary_overview: resultOf(
    z.object({
      document: z.string(),
      detail: z.enum(["concise", "detailed"]),
      segments: z.array(
        z.object({
          name: z.string(),
          start: z.string(),
          end: z.string(),
          length: z.number().min(0).optional(),
        }),
      ),
      segment_count: z.number().int().min(0),
      procedure_count: z.number().int().min(0),
      string_count: z.number().int().min(0),
    }),
  ),
  analyze_function: functionDossierOutput,
  trace_feature: resultOf(
    z.object({
      query: z.string(),
      search_mode: z.literal("literal"),
      operations_used: z.number().int().min(0),
      operation_budget: z.number().int().min(1),
      matches: z.array(
        z.object({
          type: z.enum(["string", "procedure"]),
          address: z.string(),
          value: z.string(),
        }),
      ),
      references: z.array(
        z.object({
          target_address: z.string(),
          source_address: z.string(),
          containing_procedure: containingProcedureResolution,
        }),
      ),
      truncated: z.boolean(),
      residual_unknowns: z.array(z.string()),
    }),
  ),
};

/** Exact structured-content schemas for target lifecycle operations. */
export const sessionOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  open_binary: lifecycleResultOf(
    z.object({
      path: z.string(),
      format: z.enum(["hopper", "mach-o", "elf", "pe"]),
      kind: z.enum(["executable", "database"]),
      loaderArgs: z.array(z.string()),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      architecture: z.enum(["x86", "x86_64", "arm", "arm64"]).nullable(),
    }),
  ),
  close_binary: lifecycleResultOf(z.null()),
  binary_session: lifecycleResultOf(
    z.union([
      z.object({ open: z.literal(false) }),
      z.object({
        open: z.literal(true),
        path: z.string(),
        format: z.enum(["hopper", "mach-o", "elf", "pe"]),
        kind: z.enum(["executable", "database"]),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        architecture: z.enum(["x86", "x86_64", "arm", "arm64"]).nullable(),
      }),
    ]),
  ),
  export_evidence_bundle: lifecycleResultOf(evidenceBundleSchema),
  import_evidence_bundle: lifecycleResultOf(
    z.object({
      imported: z.number().int().min(0),
      total: z.number().int().min(0),
    }),
  ),
  capture_process_scenario: lifecycleResultOf(
    evidenceSchema
      .omit({ result: true })
      .extend({ result: processCaptureSchema }),
  ),
  compare_process_captures: lifecycleResultOf(
    evidenceSchema.omit({ result: true }).extend({
      result: z.object({
        status: comparisonStatus,
        terminal: comparisonStatus,
        exit: comparisonStatus,
        filesystem: comparisonStatus,
        protocol: comparisonStatus,
        process: comparisonStatus,
        limitations: z.array(z.string()),
      }),
    }),
  ),
};
