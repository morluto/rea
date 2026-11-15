import { z } from "zod";
import { cdpResourceColumnSchema } from "../../domain/cdpObservationSchemas.js";

const integer = z.int().min(0);
/** The full reported synchronous and embedded asynchronous stack is retained. */
export const runtimeStackSchema = z.object({
  callFrames: z.array(
    z.object({
      scriptId: z.string(),
      url: z.string(),
      lineNumber: integer,
      columnNumber: cdpResourceColumnSchema,
      functionName: z.string(),
    }),
  ),
  parent: z.unknown().optional(),
  parentId: z
    .object({ id: z.string(), debuggerId: z.string().optional() })
    .optional(),
});
/** Native listener descriptors omit live remote handles from portable evidence. */
export const runtimeListenersSchema = z.object({
  listeners: z.array(
    z.object({
      type: z.string(),
      useCapture: z.boolean(),
      passive: z.boolean(),
      once: z.boolean(),
      scriptId: z.string(),
      lineNumber: integer,
      columnNumber: cdpResourceColumnSchema,
    }),
  ),
});
