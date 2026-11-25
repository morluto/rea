import { z } from "zod";

import { knownCoverageStatusSchema } from "../coverage.js";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";
import {
  aliasTargetSchema,
  byteRangeSchema,
  canonSchema,
  componentSortSchema,
  componentTypeSchema,
  coreExternTypeSchema,
  coreTypeSchema,
  definedIndexSchema,
  externTypeSchema,
  indexSchema,
  nameAttributeSchema,
  sortIndexSchema,
  typeScopeSchema,
  valTypeSchema,
} from "./wasmComponentTypes.js";

/** Component-model binary grammar admitted by the bundled decoder. */
export const WASM_COMPONENT_GRAMMAR = {
  source:
    "https://github.com/WebAssembly/component-model/blob/06e3db039e38588e2643a9417bf5d03100feafde/design/mvp/Binary.md",
  commit: "06e3db039e38588e2643a9417bf5d03100feafde",
  version: 0x0d,
  layer: 0x01,
} as const;

/** One explicitly selected local file; no binary session is required. */
export const inspectWasmComponentInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute selected local WebAssembly component path",
  ),
});
export type InspectWasmComponentInput = z.infer<
  typeof inspectWasmComponentInputSchema
>;

const coreModuleInterfaceSchema = z.strictObject({
  status: z.enum(["decoded", "not_decoded"]),
  reason: z.string().nullable(),
  imports: z.array(
    z.strictObject({
      module: z.string(),
      name: z.string(),
      type: coreExternTypeSchema,
    }),
  ),
  exports: z.array(
    z.strictObject({
      name: z.string(),
      kind: z.enum(["func", "table", "memory", "global", "tag"]),
      index: indexSchema,
    }),
  ),
});

const definesSchema = sortIndexSchema.extend({ index: definedIndexSchema });

/** One component scope; nested components refer to their parent by id. */
export const decodedComponentSchema = z.strictObject({
  id: indexSchema,
  parent: indexSchema.nullable(),
  /** Index in the parent's component index space; null for the root. */
  index: definedIndexSchema,
  range: byteRangeSchema,
  sha256: digestSchema,
  sections: z.array(
    z.strictObject({
      id: z.number().int().min(0).max(255),
      kind: z.string().min(1),
      range: byteRangeSchema,
      status: z.enum(["decoded", "not_decoded"]),
    }),
  ),
  core_modules: z.array(
    z.strictObject({
      index: definedIndexSchema,
      range: byteRangeSchema,
      sha256: digestSchema,
      core_version: z.number().int().nonnegative().nullable(),
      interface: coreModuleInterfaceSchema,
    }),
  ),
  core_instances: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("instantiate"),
        index: definedIndexSchema,
        range: byteRangeSchema,
        module: indexSchema,
        args: z.array(
          z.strictObject({ name: z.string(), instance: indexSchema }),
        ),
      }),
      z.strictObject({
        kind: z.literal("inline-exports"),
        index: definedIndexSchema,
        range: byteRangeSchema,
        exports: z.array(
          z.strictObject({
            name: z.string(),
            sort: componentSortSchema,
            index: indexSchema,
          }),
        ),
      }),
    ]),
  ),
  core_types: z.array(
    z.strictObject({
      index: definedIndexSchema,
      range: byteRangeSchema,
      type: coreTypeSchema,
    }),
  ),
  instances: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("instantiate"),
        index: definedIndexSchema,
        range: byteRangeSchema,
        component: indexSchema,
        args: z.array(
          z.strictObject({
            name: z.string(),
            sort: componentSortSchema,
            index: indexSchema,
          }),
        ),
      }),
      z.strictObject({
        kind: z.literal("inline-exports"),
        index: definedIndexSchema,
        range: byteRangeSchema,
        exports: z.array(
          z.strictObject({
            name: z.string(),
            attributes: z.array(nameAttributeSchema),
            sort: componentSortSchema,
            index: indexSchema,
          }),
        ),
      }),
    ]),
  ),
  aliases: z.array(
    z.strictObject({
      range: byteRangeSchema,
      sort: componentSortSchema,
      target: aliasTargetSchema,
      defines: definesSchema,
    }),
  ),
  types: z.array(
    z.strictObject({
      index: definedIndexSchema,
      range: byteRangeSchema,
      type: componentTypeSchema,
    }),
  ),
  canons: z.array(canonSchema),
  start: z
    .strictObject({
      range: byteRangeSchema,
      func: indexSchema,
      args: z.array(indexSchema),
      results: indexSchema,
    })
    .nullable(),
  imports: z.array(
    z.strictObject({
      range: byteRangeSchema,
      name: z.string(),
      attributes: z.array(nameAttributeSchema),
      type: externTypeSchema,
      defines: definesSchema,
    }),
  ),
  exports: z.array(
    z.strictObject({
      range: byteRangeSchema,
      name: z.string(),
      attributes: z.array(nameAttributeSchema),
      target: sortIndexSchema,
      type: externTypeSchema.nullable(),
      defines: definesSchema,
    }),
  ),
  values: z.array(
    z.strictObject({
      index: definedIndexSchema,
      range: byteRangeSchema,
      type: valTypeSchema,
    }),
  ),
  names: z
    .strictObject({
      range: byteRangeSchema,
      status: z.enum(["decoded", "invalid"]),
      reason: z.string().nullable(),
      component: z.string().nullable(),
      sorts: z.array(
        z.strictObject({
          sort: componentSortSchema,
          names: z.array(
            z.strictObject({ index: indexSchema, name: z.string() }),
          ),
        }),
      ),
    })
    .nullable(),
  custom_sections: z.array(
    z.strictObject({ name: z.string(), range: byteRangeSchema }),
  ),
  /** Canonical lifts traced to the core export they wrap. */
  lifts: z.array(
    z.strictObject({
      canon: indexSchema,
      func: definedIndexSchema,
      core_func: indexSchema,
      type: indexSchema,
      core_source: z
        .strictObject({
          core_instance: indexSchema,
          name: z.string(),
          core_module: indexSchema.nullable(),
          /** Whether the module's decoded interface exports this function; null if unknown. */
          declared_by_module: z.boolean().nullable(),
        })
        .nullable(),
      exported_as: z.array(z.string()),
    }),
  ),
  /** Canonical lowers traced to their component source and the core imports they satisfy. */
  lowers: z.array(
    z.strictObject({
      canon: indexSchema,
      func: indexSchema,
      core_func: definedIndexSchema,
      component_source: z
        .discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("import"), name: z.string() }),
          z.strictObject({
            kind: z.literal("instance-export"),
            instance: indexSchema,
            name: z.string(),
            instance_import: z.string().nullable(),
          }),
        ])
        .nullable(),
      satisfies: z.array(
        z.strictObject({
          core_instance: indexSchema,
          core_module: indexSchema,
          import_module: z.string(),
          import_name: z.string(),
          /** Whether the module's decoded interface imports this function; null if unknown. */
          declared_by_module: z.boolean().nullable(),
        }),
      ),
    }),
  ),
});
export type DecodedComponent = z.infer<typeof decodedComponentSchema>;

export const gatedFeatureSchema = z.enum([
  "values-and-start",
  "async",
  "async-forward",
  "error-context",
  "fixed-size-list",
  "map",
  "threads",
  "shared-threads",
  "implements",
  "version-suffix",
]);
export type GatedFeature = z.infer<typeof gatedFeatureSchema>;

/**
 * Content that was not decoded. `unsupported` is well-framed content outside
 * the decoded grammar; `malformed` is broken framing inside an embedded core
 * module or the name section, which never rejects the component itself.
 */
const notDecodedSchema = z.strictObject({
  component: indexSchema,
  range: byteRangeSchema,
  kind: z.enum(["unsupported", "malformed"]),
  reason: z.string().min(1),
});

/** Structural decoding of one component; type-correctness is never claimed. */
export const wasmComponentSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: z.number().int().nonnegative(),
  }),
  decoder: z.strictObject({
    id: z.literal("wasm-component-binary"),
    version: z.literal("1"),
    grammar: z.literal(WASM_COMPONENT_GRAMMAR.source),
    admitted_version: z.literal(WASM_COMPONENT_GRAMMAR.version),
    admitted_layer: z.literal(WASM_COMPONENT_GRAMMAR.layer),
  }),
  validation: z.literal("not_performed"),
  components: z.array(decodedComponentSchema).min(1),
  type_scopes: z.array(typeScopeSchema),
  gated_features: z.array(gatedFeatureSchema),
  coverage: z.strictObject({
    status: knownCoverageStatusSchema,
    not_decoded: z.array(notDecodedSchema),
  }),
  limitations: z.array(z.string()),
});
export type WasmComponent = z.infer<typeof wasmComponentSchema>;
