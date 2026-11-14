import { z } from "zod";
import { dexDescriptorSchema } from "./dexTypes.js";

const count = z.int().nonnegative().safe();

/** One original ACC_NATIVE declaration, before decompiler class deduplication. */
export const androidNativeDeclarationSchema = z.strictObject({
  source_index: count,
  class_name: z.string().min(1),
  method_name: z.string().min(1),
  descriptor: dexDescriptorSchema,
  dex_entry: z.string().min(1),
  /** Central-directory ordinal; duplicate names are explicitly unsupported. */
  dex_entry_index: count,
  /** Class-definition ordinal within this DEX. */
  class_index: count,
  /** Method-reference index in the originating DEX. */
  method_index: count,
});

/** Split requirements the bridge reads from the root manifest, or why they are unknown. */
export const androidManifestSplitsSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("observed"),
    required_split_types: z.array(z.string().min(1)),
    split_required: z.boolean(),
  }),
  z.strictObject({ status: z.literal("unknown"), reason: z.string().min(1) }),
]);

/** Scope is standard root classes*.dex members, never runtime-loaded code. */
export const androidNativeDeclarationsSchema = z.strictObject({
  scope: z.literal("apk-root-dex-declarations"),
  methods: z.array(androidNativeDeclarationSchema),
  coverage: z.strictObject({
    status: z.enum(["complete", "partial", "unknown"]),
    dex_entries: count,
    examined_dex_entries: count,
    examined_classes: count,
    examined_methods: count,
  }),
  unknowns: z.array(z.string()),
  /** Root manifest split requirements; required splits can carry native libraries. */
  manifest_splits: androidManifestSplitsSchema,
});

export type AndroidNativeDeclarations = z.infer<
  typeof androidNativeDeclarationsSchema
>;
