import { z } from "zod";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";

/** Normalize an IDA hexadecimal coordinate without passing through a JavaScript number. */
export const idaAddressSchema = z
  .string()
  .regex(/^(?:0x)?[0-9a-f]+$/iu)
  .transform(
    (value) =>
      `0x${BigInt(value.startsWith("0x") || value.startsWith("0X") ? value : `0x${value}`).toString(16)}`,
  );

/** A function observation; size is an enclosing span, never a complete body. */
export const idaFunctionSchema = z.union([
  z.object({
    address: idaAddressSchema,
    name: z.string().min(1),
    size: z.string(),
  }),
  z
    .object({
      addr: idaAddressSchema,
      name: z.string().min(1),
      size: z.string(),
    })
    .transform(({ addr, ...rest }) => ({ address: addr, ...rest })),
]);
export type IdaFunction = z.infer<typeof idaFunctionSchema>;

/** Legacy metadata describes the recorded input, whereas modern health names live paths. */
export const legacyMetadataSchema = z
  .object({
    path: z.string().min(1),
    module: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    base: idaAddressSchema,
  })
  .passthrough();
export const modernHealthSchema = z
  .object({
    status: z.literal("ok"),
    input_path: z.string().min(1),
    idb_path: z.string().nullable(),
    imagebase: idaAddressSchema,
    auto_analysis_ready: z.boolean().nullable(),
    module: z.string(),
  })
  .passthrough();

/** An upstream cursor must either finish or advance strictly to avoid replay loops. */
export const cursorSchema = z.union([
  z.object({ next: z.number().int().nonnegative() }),
  z.object({ done: z.literal(true) }),
]);
export const nextOffset = (
  cursor: z.infer<typeof cursorSchema>,
  current: number,
): number | null => {
  if ("done" in cursor) return null;
  if (cursor.next <= current)
    throw new AnalysisProtocolError(
      "IDA MCP pagination did not advance its offset.",
    );
  return cursor.next;
};

export const legacyPageSchema = z.object({
  data: z.array(jsonValueSchema),
  next_offset: z.number().int().nonnegative().nullable(),
});
export const modernPageSchema = z
  .array(
    z.object({
      data: z.array(jsonValueSchema),
      next_offset: z.number().int().nonnegative().nullable(),
    }),
  )
  .length(1);

export const modernLookupSchema = z
  .array(
    z.object({
      query: z.string(),
      fn: idaFunctionSchema.nullable(),
      error: z.string().nullable(),
    }),
  )
  .length(1);

const instructionSchema = z.union([
  z.object({
    address: idaAddressSchema,
    instruction: z.string(),
    comments: z.array(z.string()).nullish(),
  }),
  z
    .object({
      addr: idaAddressSchema,
      instruction: z.string(),
      comments: z.array(z.string()).nullish(),
    })
    .transform(({ addr, ...rest }) => ({ address: addr, ...rest })),
]);
export const disassemblySchema = z.object({
  name: z.string(),
  start_ea: idaAddressSchema,
  lines: z.array(instructionSchema),
  return_type: z.string().nullish(),
  arguments: z
    .array(z.object({ name: z.string(), type: z.string() }))
    .nullish(),
});
export type IdaDisassembly = z.infer<typeof disassemblySchema>;
export const modernDisassemblySchema = z.object({
  asm: disassemblySchema.nullable(),
  error: z.string().optional(),
  cursor: cursorSchema,
});
export const modernDecompileSchema = z.object({
  code: z.string().nullable(),
  error: z.string().optional(),
  cursor: cursorSchema,
  line_count: z.number().int().nonnegative().optional(),
  total_lines: z.number().int().nonnegative().optional(),
});

export const legacyStringSchema = z.object({
  address: idaAddressSchema,
  string: z.string(),
  length: z.number().int().nonnegative(),
});
export const modernStringsSchema = z.object({
  matches: z.array(z.object({ addr: idaAddressSchema, string: z.string() })),
  cursor: cursorSchema,
});
export const legacyXrefsSchema = z.array(
  z.object({
    address: idaAddressSchema,
    type: z.string(),
    function: idaFunctionSchema.nullable(),
  }),
);
export const modernXrefsSchema = z
  .array(
    z.object({
      xrefs: z
        .array(
          z.object({
            addr: idaAddressSchema,
            type: z.string(),
            fn: idaFunctionSchema.nullable(),
          }),
        )
        .nullable(),
      error: z.string().optional(),
      more: z.boolean().optional(),
    }),
  )
  .length(1);
export const modernCalleesSchema = z
  .array(
    z.object({
      callees: z
        .array(
          z.object({
            addr: idaAddressSchema,
            name: z.string(),
            type: z.enum(["internal", "external"]),
          }),
        )
        .nullable(),
      error: z.string().optional(),
      more: z.boolean().optional(),
    }),
  )
  .length(1);
export const legacyCalleesSchema = z.array(
  z.object({ address: idaAddressSchema, name: z.string() }).passthrough(),
);

/** Parsed database lifecycle observations retain explicit ownership information. */
export const openDatabaseSchema = z
  .object({
    success: z.literal(true),
    session: z
      .object({ session_id: z.string().min(1), input_path: z.string().min(1) })
      .passthrough(),
  })
  .passthrough();
export const databaseListSchema = z
  .object({
    sessions: z.array(
      z
        .object({
          session_id: z.string(),
          input_path: z.string(),
          owned: z.boolean(),
          backend: z.enum(["worker", "gui"]),
          is_active: z.boolean(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export const closeDatabaseSchema = z
  .object({
    success: z.literal(true),
    session_id: z.string(),
    saved: z.boolean().nullable().optional(),
    owned: z.boolean(),
    backend: z.enum(["worker", "gui"]),
  })
  .passthrough();
