import { z } from "zod";

/** Exact instruction location within the active analysis program. */
export const nativeInstructionInputSchema = z.strictObject({
  address: z.string().min(1),
  document: z.string().optional(),
});
const reference = z.strictObject({
  target_address: z.string(),
  type: z.string(),
  call: z.boolean(),
  jump: z.boolean(),
  indirect: z.boolean(),
  computed: z.boolean(),
  operand_index: z.number().int(),
  source_address: z.string().min(1).nullable().optional(),
  data: z.boolean().nullable().optional(),
  read: z.boolean().nullable().optional(),
  write: z.boolean().nullable().optional(),
  primary: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "Provider primary-reference status, not proof of literal addressing or a runtime access. Null or omission means unavailable.",
    ),
  provenance: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Provider subsystem reporting this reference; null or omission means unavailable.",
    ),
  source: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Provider reference origin, such as analysis, default, imported or user_defined; null or omission means unavailable.",
    ),
});
/** Provider-decoded facts for one instruction; operand tokens preserve their native ordering. */
export const nativeInstructionSchema = z.strictObject({
  address: z.string(),
  status: z.enum([
    "decoded",
    "not-instruction-boundary",
    "data",
    "undecodable",
    "outside-memory",
  ]),
  procedure: z.string().nullable(),
  architecture: z.string(),
  mode: z.string(),
  bytes: z.string().nullable(),
  length: z.number().int().positive().nullable(),
  mnemonic: z.string().nullable(),
  raw_disassembly: z.string().nullable(),
  operands: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      raw: z.string(),
      provider_type: z.number().int(),
      components: z.array(
        z.strictObject({
          kind: z.enum(["register", "immediate", "address", "unknown"]),
          text: z.string(),
          value: z.string().nullable(),
          bit_width: z.number().int().nonnegative().nullable(),
        }),
      ),
      memory_addressing: z.literal("unavailable"),
    }),
  ),
  flow: z.strictObject({
    kind: z.enum([
      "call",
      "jump",
      "return",
      "fallthrough",
      "terminal",
      "unavailable",
    ]),
    conditional: z.boolean(),
    computed: z.boolean(),
    direct_destinations: z.array(z.string()),
    classification_evidence: z
      .array(
        z.strictObject({
          source: z.string().min(1),
          value: z.string().min(1),
        }),
      )
      .optional()
      .describe(
        "Observed provider facts used to classify flow; older captures or other providers may omit them.",
      ),
  }),
  references: z.array(reference),
  limitations: z.array(z.string()),
});

/** Static target resolution preserves provider references as evidence, never runtime certainty. */
export const nativeCallTargetsSchema = z.strictObject({
  call_site: z.string(),
  procedure: z.string().nullable(),
  status: z.enum([
    "direct",
    "resolved-indirect",
    "ambiguous",
    "unresolved",
    "not-call",
    "unavailable",
  ]),
  mechanism: z.enum(["direct", "computed", "indirect", "unavailable"]),
  targets: z.array(
    z.strictObject({
      address: z.string(),
      procedure: z.string().nullable(),
      status: z.enum(["direct", "resolved-indirect", "candidate"]),
      basis: z.literal("provider-reference"),
      references: z.array(reference),
    }),
  ),
  limitations: z.array(z.string()),
});
