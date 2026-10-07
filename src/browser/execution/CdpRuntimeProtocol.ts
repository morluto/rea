import { z } from "zod";

const integer = z.number().int().min(0);
const contextAuxDataSchema = z
  .object({
    frameId: z.string().optional(),
    isDefault: z.boolean().optional(),
    type: z.string().optional(),
  })
  .passthrough();
/** Validated producer script metadata; optional declarations remain unknown when absent. */
export const runtimeScriptParsedSchema = z.object({
  scriptId: z.string().min(1),
  url: z.string(),
  executionContextId: integer,
  startLine: integer,
  startColumn: integer,
  endLine: integer,
  endColumn: integer,
  hash: z.string().optional(),
  sourceMapURL: z.string().optional(),
  hasSourceURL: z.boolean().optional(),
  scriptLanguage: z.string().optional(),
  executionContextAuxData: contextAuxDataSchema.optional(),
});
/** Frame ownership is taken from producer context metadata, independently of source URLs. */
export const runtimeContextSchema = z.object({
  context: z
    .object({
      id: integer,
      origin: z.string().optional(),
      name: z.string().optional(),
      uniqueId: z.string().optional(),
      auxData: contextAuxDataSchema.optional(),
    })
    .passthrough(),
});
const range = z.object({
  startOffset: integer,
  endOffset: integer,
  count: integer,
});
/** CDP precise coverage preserves every nested producer range. */
export const preciseCoverageSchema = z.object({
  timestamp: z.number().min(0),
  result: z.array(
    z.object({
      scriptId: z.string().min(1),
      url: z.string(),
      functions: z.array(
        z.object({
          functionName: z.string(),
          isBlockCoverage: z.boolean(),
          ranges: z.array(range),
        }),
      ),
    }),
  ),
});
/** The full reported synchronous and embedded asynchronous stack is retained. */
export const runtimeStackSchema = z.object({
  callFrames: z.array(
    z.object({
      scriptId: z.string(),
      url: z.string(),
      lineNumber: integer,
      columnNumber: integer,
      functionName: z.string(),
    }),
  ),
  parent: z.unknown().optional(),
  parentId: z
    .object({ id: z.string(), debuggerId: z.string().optional() })
    .optional(),
});
/** Request evidence contains metadata and producer initiators; bodies and headers are outside this tool. */
export const runtimeRequestSchema = z.object({
  requestId: z.string().min(1),
  frameId: z.string().optional(),
  timestamp: z.number().min(0),
  request: z.object({ url: z.string(), method: z.string() }),
  initiator: z
    .object({
      type: z.string(),
      stack: z.unknown().optional(),
      url: z.string().optional(),
      lineNumber: integer.optional(),
      columnNumber: integer.optional(),
    })
    .passthrough(),
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
      columnNumber: integer,
    }),
  ),
});
/** Current main frame identity protects same-URL reloads as well as URL changes. */
export const runtimeFrameTreeSchema = z.object({
  frameTree: z.object({
    frame: z.object({
      id: z.string().min(1),
      url: z.string(),
      loaderId: z.string().optional(),
    }),
  }),
});
