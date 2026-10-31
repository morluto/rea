import { z } from "zod";

import { localPathStringSchema } from "../localPath.js";

/**
 * Qualifier names REA reports, in mrm_pri2 (Windows 10) type-code order 0-11.
 * Older format generations number some of them differently.
 */
export const PRI_QUALIFIER_NAMES = [
  "Language",
  "Contrast",
  "Scale",
  "HomeRegion",
  "TargetSize",
  "LayoutDirection",
  "Theme",
  "AlternateForm",
  "DXFeatureLevel",
  "Configuration",
  "DeviceFamily",
  "Custom",
] as const;

/** Stored resource value type codes 0-6, in code order. */
export const PRI_VALUE_TYPES = [
  "String",
  "Path",
  "EmbeddedData",
  "AsciiString",
  "Utf8String",
  "AsciiPath",
  "Utf8Path",
] as const;

/** Section roles REA recognizes by their exact 16-byte identifiers. */
export const PRI_SECTION_KINDS = [
  "descriptor",
  "hierarchical-schema",
  "decision-info",
  "resource-map",
  "data-items",
  "reverse-map",
  "referenced-files",
  "unrecognized",
] as const;

/** Rows one call can page through; every response also carries the file summary. */
export const PRI_COLLECTIONS = [
  "items",
  "candidates",
  "sections",
  "qualifiers",
] as const;

const PAGE_LIMIT_MAXIMUM = 1000;
const ITEM_SELECTORS = ["names", "query", "qualifiers", "value_types"] as const;

const uint = z.number().int().min(0).max(0xffffffff);
const range = z.strictObject({ offset: uint, bytes: uint });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const qualifierName = z.enum(PRI_QUALIFIER_NAMES);
const valueType = z.enum(PRI_VALUE_TYPES);

/** One bounded, read-only selection over a caller-selected PRI file. */
export const inspectPriResourcesInputSchema = z
  .strictObject({
    path: localPathStringSchema.describe(
      "Absolute filesystem path to a Windows Package Resource Index (.pri) file",
    ),
    collection: z
      .enum(PRI_COLLECTIONS)
      .default("items")
      .describe(
        "Rows to page: items (named resources with candidate counts; default), candidates (qualifiers and decoded values), sections (complete section table) or qualifiers (stored qualifier table with priorities and fallback scores)",
      ),
    names: z
      .array(z.string().min(1).max(65535))
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "Exact, case-sensitive full resource names such as Resources/AppDisplayName or Files/Assets/Logo.png; items and candidates only",
      ),
    query: z
      .string()
      .min(1)
      .max(65535)
      .optional()
      .describe(
        "Case-insensitive substring of full resource names; items and candidates only",
      ),
    qualifiers: z
      .array(
        z.strictObject({
          name: qualifierName,
          value: z.string().max(65535),
        }),
      )
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Keep candidates whose qualifier set has a listed value (ASCII case-insensitive) for every listed qualifier name; values listed for the same name are alternatives. Candidates without that qualifier do not match. Items keep only matching candidates; items and candidates only",
      ),
    value_types: z
      .array(valueType)
      .min(1)
      .max(PRI_VALUE_TYPES.length)
      .optional()
      .describe(
        "Stored value types to keep. Text is stored as String (UTF-16), AsciiString or Utf8String; file paths as Path, AsciiPath or Utf8Path; items and candidates only",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(0xffffffff)
      .default(0)
      .describe("Zero-based offset in the stable filtered row order"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PAGE_LIMIT_MAXIMUM)
      .default(100)
      .describe(
        "Maximum rows to return (default 100). A page also ends early at its 1 MiB serialized-row budget; follow page.next_offset",
      ),
    max_file_bytes: z
      .number()
      .int()
      .min(48)
      .max(536870912)
      .default(67108864)
      .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  })
  .superRefine((input, context) => {
    if (input.collection !== "sections" && input.collection !== "qualifiers")
      return;
    for (const selector of ITEM_SELECTORS)
      if (input[selector] !== undefined)
        context.addIssue({
          code: "custom",
          path: [selector],
          message: `${selector} selects items or candidates and cannot be combined with the ${input.collection} collection`,
        });
  })
  .meta({
    if: {
      properties: { collection: { enum: ["sections", "qualifiers"] } },
      required: ["collection"],
    },
    then: {
      not: {
        anyOf: ITEM_SELECTORS.map((selector) => ({ required: [selector] })),
      },
    },
  });

const qualifierReference = z.strictObject({
  index: uint,
  name: z.enum([...PRI_QUALIFIER_NAMES, "Unknown"]),
  value: z.string(),
});

const itemRow = z.strictObject({
  map: uint,
  item: uint,
  name: z.string(),
  decision: uint.nullable(),
  candidates: uint,
  value_types: z.array(z.enum([...PRI_VALUE_TYPES, "Unknown"])),
});

const candidateRow = z.strictObject({
  map: uint,
  item: uint,
  name: z.string(),
  candidate: uint,
  qualifier_set: uint,
  qualifiers: z.array(qualifierReference),
  value_type: z.enum([...PRI_VALUE_TYPES, "Unknown"]),
  value_type_code: uint,
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("data-item"),
      section: uint,
      index: uint,
      location: range,
    }),
    z.strictObject({ kind: z.literal("inline"), location: range }),
    z.strictObject({
      kind: z.literal("external"),
      referenced_file: uint,
      section: uint,
      index: uint,
    }),
  ]),
  value: z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("text"),
        encoding: z.enum(["utf-16le", "ascii", "utf-8"]),
        text: z.string(),
        truncated: z.boolean(),
        well_formed: z.boolean().nullable(),
      }),
      z.strictObject({ kind: z.literal("bytes"), sha256 }),
    ])
    .nullable(),
});

const sectionRow = z.strictObject({
  index: uint,
  identifier: z.string().length(16),
  kind: z.enum(PRI_SECTION_KINDS),
  interpreted: z.boolean(),
  qualifier: uint,
  flags: uint,
  section_flags: uint,
  location: range,
});

const qualifierRow = z.strictObject({
  decision_info_section: uint,
  index: uint,
  name: z.enum([...PRI_QUALIFIER_NAMES, "Unknown"]),
  type_code: uint,
  value: z.string(),
  priority: uint,
  fallback_score: uint,
  referenced: z.boolean(),
});

const pageFields = {
  offset: uint,
  limit: uint,
  total: uint,
  returned: uint,
  next_offset: uint.nullable(),
  end: z.enum(["exhausted", "limit", "byte_budget"]),
};

/** File structure summary plus one caller-selected page of original-index rows. */
export const priResourcesSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: uint,
  }),
  header: z.strictObject({
    magic: z.enum(["mrm_pri0", "mrm_pri1", "mrm_pri2", "mrm_prif"]),
    declared_bytes: uint,
    toc: range,
    sections_offset: uint,
    section_count: uint,
    footer: range,
  }),
  descriptor: z.strictObject({
    section: uint,
    flags: uint,
    auto_merge: z.boolean(),
    deployment_mergeable: z.boolean(),
    primary_resource_map_section: uint.nullable(),
    included_file_list_section: uint.nullable(),
  }),
  section_summary: z.array(
    z.strictObject({
      kind: z.enum(PRI_SECTION_KINDS),
      identifier: z.string().length(16),
      sections: uint,
      interpreted: uint,
      bytes: uint,
    }),
  ),
  resource_maps: z.array(
    z.strictObject({
      section: uint,
      version: z.union([z.literal(1), z.literal(2)]),
      primary: z.boolean(),
      name: z.string(),
      unique_name: z.string(),
      schema: z.strictObject({
        section: uint,
        extended: z.boolean(),
        major_version: uint,
        minor_version: uint,
        checksum: uint,
        scopes: uint,
        items: uint,
      }),
      decision_info_section: uint,
      environment_references: z.strictObject({ count: uint, bytes: uint }),
      schema_reference_bytes: uint,
      items_with_candidates: uint,
      candidates: uint,
      top_level_scopes: z.array(
        z.strictObject({ name: z.string(), items: uint }),
      ),
    }),
  ),
  qualifier_values: z.array(
    z.strictObject({
      name: z.enum([...PRI_QUALIFIER_NAMES, "Unknown"]),
      values: z.array(z.string()),
    }),
  ),
  value_types: z.array(
    z.strictObject({
      value_type: z.enum([...PRI_VALUE_TYPES, "Unknown"]),
      candidates: uint,
    }),
  ),
  page: z.discriminatedUnion("collection", [
    z.strictObject({
      collection: z.literal("items"),
      ...pageFields,
      items: z.array(itemRow),
    }),
    z.strictObject({
      collection: z.literal("candidates"),
      ...pageFields,
      candidates: z.array(candidateRow),
    }),
    z.strictObject({
      collection: z.literal("sections"),
      ...pageFields,
      sections: z.array(sectionRow),
    }),
    z.strictObject({
      collection: z.literal("qualifiers"),
      ...pageFields,
      qualifiers: z.array(qualifierRow),
    }),
  ]),
  coverage: z.strictObject({
    status: z.literal("complete"),
    sections: uint,
    interpreted_sections: uint,
    items: uint,
    items_without_candidates: uint,
    candidates: uint,
    external_candidates: uint,
  }),
  unknowns: z.array(z.string()),
  limitations: z.array(z.string()),
});

/** Evidence parameters: the parsed selection with omitted optional selectors left out. */
export const priInspectionParameters = (input: InspectPriResourcesInput) => ({
  path: input.path,
  collection: input.collection,
  ...(input.names === undefined ? {} : { names: input.names }),
  ...(input.query === undefined ? {} : { query: input.query }),
  ...(input.qualifiers === undefined
    ? {}
    : {
        qualifiers: input.qualifiers.map(({ name, value }) => ({
          name,
          value,
        })),
      }),
  ...(input.value_types === undefined
    ? {}
    : { value_types: input.value_types }),
  offset: input.offset,
  limit: input.limit,
  max_file_bytes: input.max_file_bytes,
});

/** Qualifier values compare ASCII case-insensitively (stored tags vary: EN-US, en-US). */
const qualifierValueKey = (value: string): string =>
  value.replace(/[a-z]/gu, (letter) => letter.toUpperCase());

/** Name predicate of one caller selection: exact names and a case-insensitive substring. */
export const priNameSelection = (
  input: Pick<InspectPriResourcesInput, "names" | "query">,
): ((name: string) => boolean) => {
  const names = input.names === undefined ? undefined : new Set(input.names);
  const query = input.query?.toLowerCase();
  return (name) =>
    (names === undefined || names.has(name)) &&
    (query === undefined || name.toLowerCase().includes(query));
};

/**
 * Qualifier predicate of one caller selection, or undefined when unfiltered.
 * Every selected qualifier name needs one of its listed values.
 */
export const priQualifierSelection = (
  filter: InspectPriResourcesInput["qualifiers"],
):
  | ((
      qualifiers: readonly { readonly name: string; readonly value: string }[],
    ) => boolean)
  | undefined => {
  if (filter === undefined) return undefined;
  const wanted = new Map<string, Set<string>>();
  for (const { name, value } of filter)
    wanted.set(
      name,
      (wanted.get(name) ?? new Set<string>()).add(qualifierValueKey(value)),
    );
  return (qualifiers) =>
    [...wanted].every(([name, values]) =>
      qualifiers.some(
        (qualifier) =>
          qualifier.name === name &&
          values.has(qualifierValueKey(qualifier.value)),
      ),
    );
};

export type PriResources = z.infer<typeof priResourcesSchema>;
export type InspectPriResourcesInput = z.infer<
  typeof inspectPriResourcesInputSchema
>;
export type PriPage = PriResources["page"];
export type PriCandidateRow = z.infer<typeof candidateRow>;
export type PriItemRow = z.infer<typeof itemRow>;
export type PriSectionRow = z.infer<typeof sectionRow>;
export type PriQualifierRow = z.infer<typeof qualifierRow>;
export type PriSectionKind = (typeof PRI_SECTION_KINDS)[number];
export type PriQualifierName = PriQualifierRow["name"];
export type PriValueType = PriCandidateRow["value_type"];
