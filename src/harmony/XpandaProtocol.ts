import { z } from "zod";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { XPANDA_PROVIDER_ID } from "./XpandaRelease.js";

/**
 * Producer-owned response contract of the xpanda MCP surface. JSON tool
 * results are parsed and validated here; the two text-shaped tools keep
 * producer rendering verbatim behind strictly parsed header lines, so REA
 * never reinterprets disassembly or decompilation content.
 */

/** One MCP tool result envelope: producer text plus its error flag. */
const envelopeSchema = z.object({
  content: z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .min(1),
  isError: z.boolean().optional(),
});

export class XpandaEnvelopeError extends ProviderAdapterError {
  constructor(
    operation: string,
    readonly upstream: string,
  ) {
    super(XPANDA_PROVIDER_ID, operation, {
      diagnostics: { upstream_operation: upstream },
    });
  }
}

/** Extract the producer text or fail typed when the producer reported an error. */
export const parseXpandaEnvelope = (
  operation: string,
  upstream: string,
  response: unknown,
): string => {
  let envelope: z.infer<typeof envelopeSchema>;
  try {
    envelope = envelopeSchema.parse(response);
  } catch (cause: unknown) {
    throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
      cause,
      diagnostics: {
        upstream_operation: upstream,
        reason: "The xpanda MCP server returned a malformed tool result",
        response: jsonValueSchema.parse(response ?? null),
      },
    });
  }
  const text = envelope.content.map(({ text }) => text).join("\n");
  if (envelope.isError === true)
    throw classifyProducerError(operation, upstream, text);
  return text;
};

/**
 * Map the producer's single error channel (isError text) onto REA's tagged
 * error algebra. The producer's messages are preserved as issue text or
 * diagnostics; REA never substitutes a different failure story.
 */
export const classifyProducerError = (
  operation: string,
  upstream: string,
  text: string,
):
  | ProviderAdapterError
  | AnalysisInputError
  | AnalysisCapabilityUnavailableError => {
  const reason = text.startsWith("ERROR: ")
    ? text.slice("ERROR: ".length)
    : text;
  if (upstream === "abc_load") {
    // Every abc_load failure is about the selected bytes: bad magic,
    // checksum mismatch (possibly encrypted) or an unreadable file.
    return new AnalysisInputError(
      operation,
      {
        userMessage: `The producer could not parse this file as HarmonyOS Ark bytecode: ${reason.trim()}`,
      },
      [
        {
          path: ["path"],
          reason: "invalid_value",
          message: reason.trim(),
        },
      ],
    );
  }
  if (reason.includes("类未找到")) {
    return new AnalysisInputError(operation, { userMessage: reason.trim() }, [
      {
        path: ["class_name"],
        reason: "invalid_value",
        message: reason.trim(),
      },
    ]);
  }
  if (reason.includes("方法未找到")) {
    // The producer names the class's available methods in this message.
    return new AnalysisInputError(operation, { userMessage: reason.trim() }, [
      {
        path: ["method_name"],
        reason: "invalid_value",
        message: reason.trim(),
      },
    ]);
  }
  if (reason.includes("方法是 external") || reason.includes("方法没有指令体")) {
    return new AnalysisInputError(operation, { userMessage: reason.trim() }, [
      {
        path: ["method_name"],
        reason: "invalid_value",
        message: reason.trim(),
      },
    ]);
  }
  if (reason.includes("反汇编失败")) {
    // Unimplemented conditional-jump instructions: a producer capability
    // boundary, not caller input. Disassembly or degraded output applies.
    return new AnalysisCapabilityUnavailableError(
      XPANDA_PROVIDER_ID,
      operation,
      reason.trim(),
      {
        userMessage:
          "This method uses bytecode instructions the configured xpanda release does not implement; its decompilation degrades the same way. Use the disassembly of a neighboring method or whole-file decompilation, which skips only this class.",
        remediationAction:
          "Retry disassembly after updating the caller-supplied xpanda checkout, or inspect the surrounding class with decompile_harmony_abc and the degraded flag.",
      },
    );
  }
  if (reason.includes("fileId")) {
    // REA loads before every operation, so an unknown fileId is an adapter
    // sequencing violation rather than caller input.
    return new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
      diagnostics: {
        upstream_operation: upstream,
        reason: reason.trim(),
      },
      remediationAction:
        "Retry the operation; a repeated unknown-fileId report indicates an xpanda release incompatible with this integration.",
    });
  }
  return new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
    diagnostics: {
      upstream_operation: upstream,
      reason: reason.trim(),
    },
  });
};

const producerInteger = z.number().int().min(0);
const producerBoolean = z.boolean();

/** abc_load: header facts and a class-name preview. */
export const xpandaLoadSchema = z.object({
  fileId: z.string().min(1),
  path: z.string().min(1),
  cached: producerBoolean,
  bytecodeVersion: z.string().min(1),
  checksum: z.string().min(1),
  fileSizeBytes: producerInteger,
  classCount: producerInteger,
  foreignClassCount: producerInteger,
  lnpCount: producerInteger,
  classesPreview: z.array(z.string()),
  previewTruncated: producerBoolean,
});

export type XpandaLoad = z.infer<typeof xpandaLoadSchema>;

/** abc_load on a .hap container: the package entry inventory, not bytecode facts. */
export const xpandaHapLoadSchema = z.object({
  kind: z.literal("hap"),
  fileId: z.string().min(1),
  path: z.string().min(1),
  cached: producerBoolean,
  bundleName: z.string().nullable(),
  moduleName: z.string().nullable(),
  versionName: z.string().nullable(),
  virtualMachine: z.string().nullable(),
  fileSizeBytes: producerInteger,
  abcEntries: z.array(z.object({ name: z.string(), size: producerInteger })),
  resourceItemCount: producerInteger,
  hint: z.string().optional(),
});

export type XpandaHapLoad = z.infer<typeof xpandaHapLoadSchema>;

/** A loaded producer session: .abc facts (2.x has no `kind`) or a .hap package. */
export const xpandaSessionSchema = z.union([
  xpandaHapLoadSchema,
  xpandaLoadSchema,
]);

export type XpandaSession = z.infer<typeof xpandaSessionSchema>;

/** Whether a loaded session is a .hap container rather than an .abc file. */
export const isHapLoad = (load: XpandaSession): load is XpandaHapLoad =>
  "kind" in load && load.kind === "hap";

/** abc_list_classes: one page of the demangled class inventory. */
export const xpandaClassListSchema = z.object({
  fileId: z.string().min(1),
  total: producerInteger,
  filtered: producerInteger,
  offset: producerInteger,
  returned: producerInteger,
  truncated: producerBoolean,
  classes: z.array(
    z.object({
      name: z.string(),
      methods: producerInteger,
      fields: producerInteger,
      external: producerBoolean,
    }),
  ),
});

export type XpandaClassList = z.infer<typeof xpandaClassListSchema>;

/** abc_export: whole-file decompilation written to disk. */
export const xpandaExportSchema = z.object({
  fileId: z.string().min(1),
  outDir: z.string().min(1),
  written: producerInteger,
  skipped: producerInteger,
  failed: producerInteger,
  degradedClasses: z.array(z.string()),
  files: z.array(z.string()),
  filesTruncated: producerBoolean,
});

export type XpandaExport = z.infer<typeof xpandaExportSchema>;

/** abc_search_strings: one page of string-pool matches. */
export const xpandaStringMatchesSchema = z.object({
  fileId: z.string().min(1),
  poolSize: producerInteger,
  matched: producerInteger,
  offset: producerInteger,
  returned: producerInteger,
  truncated: producerBoolean,
  strings: z.array(
    z.object({ offset: z.string().min(1), content: z.string() }),
  ),
});

export type XpandaStringMatches = z.infer<typeof xpandaStringMatchesSchema>;

/** Strict header of decompilation text results (2.x and 3.x producers). */
const DECOMPILE_HEADER_PREFIX = "// xpanda-mcp ";
/** Character count the producer caps a single-class transfer at. */
export const XPANDA_DECOMPILE_TRANSFER_CAP = 50_000;
/** Producer comment appended to a decompilation that produced nothing. */
const EMPTY_DECOMPILE_MARKER =
  "// 反编译结果为空(该类可能没有 func_main_0 入口或反编译失败)";

export interface XpandaDecompile {
  readonly className: string;
  /** The method a 3.x method-scoped decompilation names, else null. */
  readonly methodName: string | null;
  readonly simplified: boolean;
  readonly degraded: boolean;
  readonly emptyResult: boolean;
  readonly truncated: boolean;
  readonly characters: number;
  readonly content: string;
}

/**
 * Read the producer's header tokens. 2.x writes
 * `class=X simplified=… degraded=… chars=N[ TRUNCATED]`; 3.x appends
 * `lines=… cached=… offset=… returned=… truncated=…` and, for method-scoped
 * decompilation, `method=…` after the class.
 */
const parseDecompileHeader = (
  operation: string,
  headerLine: string,
): {
  readonly fields: ReadonlyMap<string, string>;
  readonly legacyTruncated: boolean;
} => {
  if (!headerLine.startsWith(DECOMPILE_HEADER_PREFIX))
    throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
      diagnostics: {
        reason:
          "decompilation output did not start with the documented xpanda header line",
        text_prefix: headerLine.slice(0, 256),
      },
      remediationAction:
        "Retry the operation; a repeated malformed header indicates an xpanda release incompatible with this integration.",
    });
  const fields = new Map<string, string>();
  let legacyTruncated = false;
  for (const token of headerLine
    .slice(DECOMPILE_HEADER_PREFIX.length)
    .split(" ")) {
    if (token.length === 0) continue;
    if (token === "TRUNCATED") {
      legacyTruncated = true;
      continue;
    }
    const equals = token.indexOf("=");
    if (equals <= 0) continue;
    fields.set(token.slice(0, equals), token.slice(equals + 1));
  }
  if (
    !fields.has("class") ||
    !fields.has("simplified") ||
    !fields.has("degraded") ||
    !fields.has("chars")
  )
    throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
      diagnostics: {
        reason: "decompilation output header omitted a documented field",
        header: headerLine,
      },
    });
  return { fields, legacyTruncated };
};

/**
 * Parse decompilation output. When the producer did not truncate, the
 * declared character count must match the transferred payload exactly; a
 * mismatch means the transfer lost bytes and fails instead of guessing.
 */
export const parseXpandaDecompile = (
  operation: string,
  text: string,
): XpandaDecompile => {
  if (text.trim() === EMPTY_DECOMPILE_MARKER)
    return {
      className: "",
      methodName: null,
      simplified: true,
      degraded: false,
      emptyResult: true,
      truncated: false,
      characters: 0,
      content: "",
    };
  const newline = text.indexOf("\n");
  if (newline <= 0)
    throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
      diagnostics: {
        reason:
          "decompilation output did not start with the documented xpanda header line",
        text_prefix: text.slice(0, 256),
      },
      remediationAction:
        "Retry the operation; a repeated malformed header indicates an xpanda release incompatible with this integration.",
    });
  const header = parseDecompileHeader(operation, text.slice(0, newline));
  const field = (name: string): string | undefined => header.fields.get(name);
  const content = text.slice(newline + 1);
  const declared = Number.parseInt(field("chars") ?? "", 10);
  const payloadTruncated =
    header.legacyTruncated || field("truncated") === "true";
  const payloadComplete = !payloadTruncated && content.length === declared;
  const legacyCapTruncation =
    header.legacyTruncated && content.length >= XPANDA_DECOMPILE_TRANSFER_CAP;
  if (!payloadComplete && !payloadTruncated)
    throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
      diagnostics: {
        reason:
          "decompilation transferred a different payload length than its header declared",
        declared_characters: declared,
        transferred_characters: content.length,
      },
    });
  if (payloadTruncated && !legacyCapTruncation) {
    // 3.x pages long output; the header names the complete character count,
    // so a page must still be a prefix no longer than that count.
    if (content.length === 0 || content.length > declared)
      throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
        diagnostics: {
          reason:
            "decompilation page length is inconsistent with its declared character count",
          declared_characters: declared,
          transferred_characters: content.length,
        },
      });
  }
  return {
    className: field("class") ?? "",
    methodName: field("method") ?? null,
    simplified: field("simplified") === "true",
    degraded: field("degraded") === "true",
    emptyResult: false,
    truncated: payloadTruncated,
    characters: declared,
    content,
  };
};

/** Strict header of abc_disassemble_method's text result. */
const DISASSEMBLE_HEADER =
  /^method: (.+)  vregs=(\d+) args=(\d+)  blocks=(\d+)\n/u;
/** Producer markers that the rendered listing was cut short. */
const DISASSEMBLE_TRUNCATION_MARKERS = [
  "已按 maxInstructions=",
  "输出已截断",
] as const;

export interface XpandaDisassembly {
  readonly methodName: string;
  readonly virtualRegisters: number;
  readonly arguments: number;
  readonly blocks: number;
  readonly truncated: boolean;
  readonly text: string;
}

/**
 * Parse abc_disassemble_method output: header facts are parsed, the block
 * listing is preserved verbatim because instruction rendering belongs to the
 * producer.
 */
export const parseXpandaDisassembly = (
  operation: string,
  text: string,
): XpandaDisassembly => {
  const header = DISASSEMBLE_HEADER.exec(text);
  if (header === null)
    throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
      diagnostics: {
        reason:
          "abc_disassemble_method output did not start with the documented xpanda header line",
        text_prefix: text.slice(0, 256),
      },
      remediationAction:
        "Retry the operation; a repeated malformed header indicates an xpanda release incompatible with this integration.",
    });
  const [, methodName, virtualRegisters, arguments_, blocks] = header;
  return {
    methodName: methodName ?? "",
    virtualRegisters: Number.parseInt(virtualRegisters ?? "", 10),
    arguments: Number.parseInt(arguments_ ?? "", 10),
    blocks: Number.parseInt(blocks ?? "", 10),
    truncated: DISASSEMBLE_TRUNCATION_MARKERS.some((marker) =>
      text.includes(marker),
    ),
    text,
  };
};

/** abc_get_class: one class's metadata tables. */
const xpandaAccessFlags = z.string().min(1);
export const xpandaClassMetadataSchema = z.object({
  fileId: z.string().min(1),
  name: z.string().min(1),
  rawName: z.string().min(1),
  superClass: z.string().nullable(),
  external: producerBoolean,
  accessFlags: xpandaAccessFlags,
  fields: z.array(
    z.object({
      name: z.string(),
      type: z.string().nullable(),
      external: producerBoolean,
    }),
  ),
  methods: z.array(
    z.object({
      name: z.string(),
      accessFlags: xpandaAccessFlags,
      external: producerBoolean,
      hasCode: producerBoolean,
      hasTryCatch: producerBoolean,
      shorty: z.string().nullable(),
    }),
  ),
  imports: z.array(
    z.object({
      localName: z.string(),
      importName: z.string(),
      path: z.string(),
      kind: z.union([z.string(), z.number()]).nullable(),
    }),
  ),
  exports: z.array(
    z.object({
      localName: z.string(),
      exportName: z.string(),
      path: z.string(),
      kind: z.union([z.string(), z.number()]).nullable(),
    }),
  ),
});

export type XpandaClassMetadata = z.infer<typeof xpandaClassMetadataSchema>;

/** abc_search_symbols: one page of class/method/field matches. */
export const xpandaSymbolSearchSchema = z.object({
  fileId: z.string().min(1),
  total: producerInteger,
  offset: producerInteger,
  limit: producerInteger,
  returned: producerInteger,
  truncated: producerBoolean,
  matches: z.array(
    z.object({
      kind: z.enum(["class", "method", "field"]),
      rawName: z.string(),
      name: z.string(),
      ownerClass: z.string().optional(),
      ownerClassName: z.string().optional(),
      type: z.string().optional(),
      methodCount: producerInteger.optional(),
      fieldCount: producerInteger.optional(),
      external: producerBoolean.optional(),
      hasCode: producerBoolean.optional(),
    }),
  ),
});

export type XpandaSymbolSearch = z.infer<typeof xpandaSymbolSearchSchema>;

/** abc_search_code: one page of decompiled-source matches. */
export const xpandaCodeSearchSchema = z.object({
  fileId: z.string().min(1),
  pattern: z.string(),
  simplified: producerBoolean,
  scannedClasses: producerInteger,
  skippedClasses: producerInteger,
  failedClasses: z.array(z.string()),
  failedClassCount: producerInteger,
  candidateClasses: producerInteger,
  truncatedClasses: producerBoolean,
  total: producerInteger,
  offset: producerInteger,
  limit: producerInteger,
  returned: producerInteger,
  truncated: producerBoolean,
  matches: z.array(
    z.object({
      className: z.string(),
      line: producerInteger,
      text: z.string(),
      method: z.string().optional(),
      methodKind: z.string().optional(),
      context: z
        .array(z.object({ line: producerInteger, text: z.string() }))
        .optional(),
    }),
  ),
  hint: z.string().optional(),
});

export type XpandaCodeSearch = z.infer<typeof xpandaCodeSearchSchema>;

/** abc_xrefs: one page of class/method/field/string references. */
export const xpandaXrefsSchema = z.object({
  fileId: z.string().min(1),
  targetType: z.enum(["class", "method", "field", "string"]),
  target: z.string(),
  targetOwner: z.string().nullable(),
  total: producerInteger,
  offset: producerInteger,
  limit: producerInteger,
  returned: producerInteger,
  truncated: producerBoolean,
  sourceScannedClasses: producerInteger,
  sourceTruncatedClasses: producerBoolean,
  xrefCount: producerInteger,
  disassemblyFailures: producerInteger,
  matches: z.array(
    z.object({
      fromClass: z.string(),
      fromClassRaw: z.string(),
      fromMethod: z.string(),
      pc: z.number().int().nullable(),
      line: z.number().int().nullable().optional(),
      opcode: z.string().nullable(),
      kind: z.string(),
      targetType: z.enum(["class", "method", "field", "string"]),
      targetName: z.string(),
      targetClass: z.string().nullable(),
      targetClassRaw: z.string().nullable(),
      origin: z.enum(["bytecode", "source"]),
    }),
  ),
  hint: z.string().optional(),
});

export type XpandaXrefs = z.infer<typeof xpandaXrefsSchema>;

/** abc_call_graph: nodes, edges and an optional Mermaid rendering. */
export const xpandaCallGraphSchema = z.object({
  fileId: z.string().min(1),
  root: z.object({
    class: z.string(),
    classRaw: z.string(),
    method: z.string(),
  }),
  direction: z.enum(["callers", "callees", "both"]),
  depth: producerInteger,
  nodeCount: producerInteger,
  edgeCount: producerInteger,
  truncated: producerBoolean,
  disassemblyFailures: producerInteger,
  sourceTruncatedClasses: producerBoolean,
  nodes: z.array(
    z.object({
      id: z.string(),
      classRaw: z.string(),
      className: z.string(),
      method: z.string(),
      depth: producerInteger,
      via: z.array(z.enum(["callers", "callees", "root"])),
    }),
  ),
  edges: z.array(
    z.object({ from: z.string(), to: z.string(), kind: z.string() }),
  ),
  mermaid: z.string().optional(),
});

export type XpandaCallGraph = z.infer<typeof xpandaCallGraphSchema>;

/** hap_read_abc: the extracted .abc entry registered as an abc session. */
export const xpandaHapAbcSchema = z.object({
  abcFileId: z.string().min(1),
  entry: z.string().min(1),
  cached: producerBoolean,
  runtime: z.enum(["dynamic", "static"]),
  bytecodeVersion: z.string().min(1),
  classCount: producerInteger,
  classesPreview: z.array(z.string()),
  previewTruncated: producerBoolean,
  hint: z.string().optional(),
});

export type XpandaHapAbc = z.infer<typeof xpandaHapAbcSchema>;

/** hap_resources: one page of the package resource table. */
export const xpandaHapResourcesSchema = z.object({
  fileId: z.string().min(1),
  format: z.enum(["Restool", "RestoolV2"]),
  version: z.union([z.string(), z.number()]),
  total: producerInteger,
  matched: producerInteger,
  byType: z.record(z.string(), producerInteger),
  byLimitKey: z.record(z.string(), producerInteger),
  offset: producerInteger,
  limit: producerInteger,
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      limitKey: z.string(),
      value: z.string(),
    }),
  ),
  truncated: producerBoolean,
});

export type XpandaHapResources = z.infer<typeof xpandaHapResourcesSchema>;
