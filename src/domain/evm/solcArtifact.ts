import { z } from "zod";
import { compilerMetadataFacts } from "./solcCompilerJson.js";
import { inspectSolcBytecodeObject } from "./solcBytecodeObject.js";

/** Exact compiler identities; source-unit names are not filesystem paths. */
export const compilerSelectionSchema = z.strictObject({
  source_unit: z.string(),
  contract_name: z.string(),
  bytecode_kind: z.enum(["creation", "deployed"]),
});
export type CompilerSelection = z.infer<typeof compilerSelectionSchema>;

const coordinate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** JSON syntax coordinates in the strictly decoded original carrier. */
export const solcSourceRangeSchema = z
  .strictObject({
    start: coordinate,
    end: coordinate,
    unit: z.literal("utf16-code-unit"),
  })
  .refine((value) => value.end >= value.start, {
    message: "Source range end precedes start",
  });
const reference = z
  .strictObject({
    source_unit: z.string().nullable(),
    library_name: z.string().nullable(),
    immutable_id: z.string().nullable(),
    start: coordinate,
    length: coordinate,
    source_range: solcSourceRangeSchema,
  })
  .refine(
    (value) =>
      value.length > 0 && Number.isSafeInteger(value.start + value.length),
    { message: "Reference requires a positive safe byte span" },
  );

const linkReference = reference.refine(
  (value) =>
    value.source_unit !== null &&
    value.library_name !== null &&
    value.immutable_id === null,
  { message: "Link reference requires source/library identity only" },
);
const immutableReference = reference.refine(
  (value) =>
    value.source_unit === null &&
    value.library_name === null &&
    value.immutable_id !== null,
  { message: "Immutable reference requires immutable identity only" },
);

export const solcCompilerDiagnosticsSchema = z
  .array(
    z.strictObject({
      raw_json: z.string(),
      source_range: solcSourceRangeSchema,
      json_pointer: z.string(),
      severity: z.string().nullable(),
    }),
  )
  .nullable();

/** Recorded compiler output facts, independently of interface inference. */
export const solcArtifactSchema = z
  .strictObject({
    selection: compilerSelectionSchema,
    json_pointer: z.string(),
    contract_range: solcSourceRangeSchema,
    bytecode_range: solcSourceRangeSchema.nullable(),
    object_range: solcSourceRangeSchema.nullable(),
    object: z.string().nullable(),
    status: z.enum(["concrete", "unlinked", "absent"]),
    reference_bounds: z.enum(["verified", "unavailable"]),
    link_references: z.array(linkReference).nullable(),
    immutable_references: z.array(immutableReference).nullable(),
    placeholders: z.array(
      z.strictObject({
        start: coordinate,
        length: coordinate,
        value: z.string(),
      }),
    ),
    diagnostics: solcCompilerDiagnosticsSchema,
    metadata: z.strictObject({
      raw: z.string().nullable(),
      source_range: solcSourceRangeSchema.nullable(),
      compiler_version: z.string().nullable(),
      settings_json: z.string().nullable(),
      parse_status: z.enum([
        "valid",
        "malformed",
        "resource-limited",
        "absent",
      ]),
    }),
  })
  .superRefine((value, context) => {
    const contains = (
      parent: { start: number; end: number },
      nested: { start: number; end: number },
    ) => nested.start >= parent.start && nested.end <= parent.end;
    if (
      value.bytecode_range !== null &&
      !contains(value.contract_range, value.bytecode_range)
    )
      context.addIssue({
        code: "custom",
        message: "Bytecode range is outside selected contract",
      });
    for (const facet of ["link_references", "immutable_references"] as const) {
      const references = value[facet];
      if (references === null) continue;
      if (value.bytecode_range === null) {
        context.addIssue({
          code: "custom",
          path: [facet],
          message: "Reference facet requires a selected bytecode node",
        });
        continue;
      }
      for (const [index, reference] of references.entries()) {
        if (!contains(value.bytecode_range, reference.source_range))
          context.addIssue({
            code: "custom",
            path: [facet, index, "source_range"],
            message: "Reference source range is outside selected bytecode",
          });
      }
    }
    if (
      value.object_range !== null &&
      (value.bytecode_range === null ||
        !contains(value.bytecode_range, value.object_range))
    )
      context.addIssue({
        code: "custom",
        message: "Object range is outside selected bytecode",
      });
    if (
      value.metadata.source_range !== null &&
      !contains(value.contract_range, value.metadata.source_range)
    )
      context.addIssue({
        code: "custom",
        message: "Metadata range is outside selected contract",
      });
  })
  .superRefine((value, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    const escape = (segment: string) =>
      segment.replaceAll("~", "~0").replaceAll("/", "~1");
    const key =
      value.selection.bytecode_kind === "creation"
        ? "bytecode"
        : "deployedBytecode";
    if (
      value.json_pointer !==
      `/contracts/${escape(value.selection.source_unit)}/${escape(value.selection.contract_name)}/evm/${key}`
    )
      issue("Compiler pointer differs from exact selection");
    if ((value.status === "absent") !== (value.object === null))
      issue("Compiler status differs from object availability");
    if ((value.reference_bounds === "unavailable") !== (value.object === null))
      issue("Reference bounds differ from object availability");
    if ((value.object_range === null) !== (value.object === null))
      issue("Object range differs from object availability");
    if (
      value.status === "concrete" &&
      (value.object === null || !/^(?:[0-9a-fA-F]{2})*$/.test(value.object))
    )
      issue(
        "Concrete compiler object must contain exact hex without placeholders",
      );
    const hasPlaceholders = value.placeholders.length > 0;
    if ((value.status === "unlinked") !== hasPlaceholders)
      issue("Placeholder presence differs from compiler object status");
    const metadata = value.metadata;
    const metadataAbsent = metadata.parse_status === "absent";
    if (metadata.parse_status === "valid") {
      const parsed = compilerMetadataFacts(metadata.raw);
      if (
        parsed.parse_status !== "valid" ||
        parsed.compiler_version !== metadata.compiler_version ||
        parsed.settings_json !== metadata.settings_json
      )
        context.addIssue({
          code: "custom",
          path: ["metadata"],
          message: "Compiler metadata facts must match the retained source.",
        });
    }
    if (
      (metadata.raw === null) !== metadataAbsent ||
      (metadata.source_range === null) !== metadataAbsent ||
      (metadata.parse_status !== "valid" &&
        (metadata.compiler_version !== null || metadata.settings_json !== null))
    )
      context.addIssue({
        code: "custom",
        path: ["metadata"],
        message:
          "Compiler metadata status requires retained source and consistent parsed fact availability.",
      });
  })
  .superRefine((value, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (value.object !== null) {
      const examined = inspectSolcBytecodeObject(value.object);
      if (!examined.ok) {
        issue(examined.error);
        return;
      }
      for (const span of [
        ...(value.link_references ?? []),
        ...(value.immutable_references ?? []),
      ]) {
        if (
          !Number.isSafeInteger(span.start + span.length) ||
          span.length === 0 ||
          span.start + span.length > examined.value.byteLength
        )
          issue("Reference span exceeds compiler object");
      }
      if (
        examined.value.placeholders.length !== value.placeholders.length ||
        examined.value.placeholders.some((placeholder, index) => {
          const recorded = value.placeholders[index];
          return (
            recorded?.start !== placeholder.start ||
            recorded.length !== placeholder.length ||
            recorded.value !== placeholder.value
          );
        })
      )
        issue("Placeholder span differs from compiler object");
    }
  });
export type SolcArtifact = z.infer<typeof solcArtifactSchema>;
