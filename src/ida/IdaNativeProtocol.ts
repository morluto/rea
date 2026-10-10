import { z } from "zod";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import {
  cursorSchema,
  disassemblySchema,
  idaAddressSchema,
  modernCalleesSchema,
  modernXrefsSchema,
} from "./IdaProtocolValues.js";

/** Native MCP renders an assembly header followed by bare hexadecimal coordinates. */
const nativeAssemblySchema = disassemblySchema
  .omit({ lines: true })
  .extend({
    lines: z.string(),
  })
  .transform((asm) => {
    const [header, ...body] = asm.lines.split("\n");
    const match = header?.match(/^(.+) \((.*) @ (0x[0-9a-f]+)\):$/iu);
    if (
      match?.[1] !== asm.name ||
      idaAddressSchema.parse(match?.[3]) !== asm.start_ea
    )
      throw new AnalysisProtocolError(
        "Native IDA assembly header contradicts its function identity.",
      );
    return {
      ...asm,
      lines: body.map((line) => {
        const item = line.match(/^([0-9a-f]+)  (.*)$/iu);
        if (item === null)
          throw new AnalysisProtocolError(
            "Native IDA returned an unsupported assembly line.",
          );
        return {
          address: idaAddressSchema.parse(item[1]),
          instruction: item[2] ?? "",
        };
      }),
    };
  });

/** Native assembly retains the same explicit pagination cursor as modern MCP. */
export const nativeDisassemblySchema = z.object({
  asm: nativeAssemblySchema.nullable(),
  error: z.string().optional(),
  cursor: cursorSchema,
});

/** GUI decompilation reports the resolved entry and an explicit success/failure. */
export const nativeDecompileSchema = z.object({
  addr: idaAddressSchema,
  ok: z.boolean(),
  pseudocode: z.string().min(1).optional(),
  lines: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

/** Native relationship successes explicitly carry null errors. Normalize that omission here. */
const nativeErrorSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
export const nativeCalleesSchema = z
  .array(modernCalleesSchema.element.extend({ error: nativeErrorSchema }))
  .length(1);
export const nativeXrefsSchema = z
  .array(modernXrefsSchema.element.extend({ error: nativeErrorSchema }))
  .length(1);

/** Read-only tools required from the native bridge; GUI lifecycle tools are excluded. */
export const nativeTools = [
  "list_funcs",
  "lookup_funcs",
  "find_regex",
  "decompile",
  "disasm",
  "callees",
  "xrefs_to",
];
