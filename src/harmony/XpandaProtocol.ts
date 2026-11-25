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

/** Strict header of abc_decompile_class's text result. */
const DECOMPILE_HEADER =
  /^\/\/ xpanda-mcp class=(.*) simplified=(true|false) degraded=(true|false) chars=(\d+)( TRUNCATED)?\n/u;
/** Character count the producer caps a single-class transfer at. */
export const XPANDA_DECOMPILE_TRANSFER_CAP = 50_000;
/** Producer comment appended to a decompilation that produced nothing. */
const EMPTY_DECOMPILE_MARKER =
  "// 反编译结果为空(该类可能没有 func_main_0 入口或反编译失败)";

export interface XpandaDecompile {
  readonly className: string;
  readonly simplified: boolean;
  readonly degraded: boolean;
  readonly emptyResult: boolean;
  readonly truncated: boolean;
  readonly characters: number;
  readonly content: string;
}

/**
 * Parse abc_decompile_class output. When the producer did not truncate, the
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
      simplified: true,
      degraded: false,
      emptyResult: true,
      truncated: false,
      characters: 0,
      content: "",
    };
  const header = DECOMPILE_HEADER.exec(text);
  if (header === null)
    throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
      diagnostics: {
        reason:
          "abc_decompile_class output did not start with the documented xpanda header line",
        text_prefix: text.slice(0, 256),
      },
      remediationAction:
        "Retry the operation; a repeated malformed header indicates an xpanda release incompatible with this integration.",
    });
  const [, className, simplified, degraded, characters, truncated] = header;
  const content = text.slice(header[0].length);
  const declared = Number.parseInt(characters ?? "", 10);
  const payloadComplete =
    truncated === undefined && content.length === declared;
  const payloadTruncated =
    truncated === " TRUNCATED" &&
    content.length >= XPANDA_DECOMPILE_TRANSFER_CAP;
  if (!payloadComplete && !payloadTruncated)
    throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
      diagnostics: {
        reason:
          "abc_decompile_class transferred a different payload length than its header declared",
        declared_characters: declared,
        transferred_characters: content.length,
        header_truncated: truncated ?? null,
      },
    });
  return {
    className: className ?? "",
    simplified: simplified === "true",
    degraded: degraded === "true",
    emptyResult: false,
    truncated: !payloadComplete,
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
