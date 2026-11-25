import { z } from "zod";

import { digestSchema } from "../digests.js";
import {
  absoluteLocalPathStringSchema,
  localPathStringSchema,
} from "../localPath.js";

const byteOffset = z.int().nonnegative();
const discriminatorSchema = z.string().regex(/^[a-f0-9]{16}$/);
/** Solana public keys are base58 encodings of 32 bytes (32–44 characters). */
export const solanaPublicKeySchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

/**
 * Select exactly one program source: an explicit local sBPF ELF, or a program
 * id whose executable is fetched read-only through Solana JSON-RPC. RPC intake
 * materializes the fetched ELF under `out_dir`, so the analyzed artifact is a
 * caller-selected local file with the same identity semantics as `--elf`.
 */
export const analyzeSolanaProgramInputSchema = z
  .strictObject({
    path: absoluteLocalPathStringSchema
      .optional()
      .describe("Absolute path to a caller-selected local sBPF ELF"),
    program_id: solanaPublicKeySchema
      .optional()
      .describe("Base58 program id to fetch through Solana JSON-RPC"),
    rpc_url: z
      .url()
      .optional()
      .describe(
        "Solana JSON-RPC endpoint for program_id intake; defaults to REA_SOLANA_RPC_URL or the public mainnet endpoint",
      ),
    out_dir: absoluteLocalPathStringSchema
      .optional()
      .describe(
        "Directory receiving the fetched ELF (required with program_id) and, when selected, the analysis artifacts",
      ),
    handoff: z
      .boolean()
      .optional()
      .describe(
        "Also write a deep-decompiler handoff under out_dir/handoff: the pinned ELF copy, handoff.json, and an analyst brief (HANDOFF.md)",
      ),
    instruction_names: z
      .array(z.string().min(1).max(64))
      .max(512)
      .optional()
      .describe(
        'Caller-supplied Anchor instruction names (e.g. from an IDL); handler candidates whose discriminator equals sha256("global:<name>")[..8] are confirmed with that name',
      ),
  })
  .superRefine((value, context) => {
    const hasPath = value.path !== undefined;
    const hasProgram = value.program_id !== undefined;
    if (hasPath === hasProgram)
      context.addIssue({
        code: "custom",
        path: ["path"],
        message:
          "Select exactly one program source: a local ELF path or a program id.",
      });
    if (hasProgram && value.out_dir === undefined)
      context.addIssue({
        code: "custom",
        path: ["out_dir"],
        message:
          "Program-id intake materializes the fetched ELF under out_dir; select it explicitly.",
      });
    if (hasPath && value.rpc_url !== undefined)
      context.addIssue({
        code: "custom",
        path: ["rpc_url"],
        message: "rpc_url applies only to program-id intake.",
      });
    if (value.handoff === true && value.out_dir === undefined)
      context.addIssue({
        code: "custom",
        path: ["out_dir"],
        message:
          "The handoff artifact is written under out_dir; select it explicitly.",
      });
  });

const sectionSchema = z.strictObject({
  name: z.string(),
  type: z.int().nonnegative(),
  address: byteOffset,
  offset: byteOffset,
  size: byteOffset,
});

/**
 * Observed ELF/RPC facts plus inferred Anchor dispatch candidates. Handler
 * rows are reconstruction leads recovered from the dispatch idioms the
 * analyzer verifies (lddw-constant compares, split 32-bit compares, and
 * read-only jump tables); they are not a verified instruction inventory.
 */
export const solanaProgramAnalysisSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: localPathStringSchema,
      sha256: digestSchema,
      bytes: byteOffset,
      source: z.enum(["local-file", "solana-rpc"]),
      program_id: z.string().nullable(),
      program_data_account: z.string().nullable(),
      slot: byteOffset.nullable(),
    }),
    elf: z.strictObject({
      bits: z.literal(64),
      byte_order: z.enum(["little", "big"]),
      elf_type: z.int().nonnegative(),
      machine: z.int().nonnegative(),
      machine_name: z.string(),
      entrypoint: byteOffset,
      program_header_count: z.int().nonnegative(),
      section_header_count: z.int().nonnegative(),
      /** File bytes beyond the extents declared by the ELF headers. */
      trailing_bytes: byteOffset,
      /** sBPF bytecode version from e_flags (decides the callx register field). */
      e_flags: z.int().nonnegative(),
      sbpf_version: z.int().nonnegative().nullable(),
      sections: z.array(sectionSchema),
    }),
    disassembly: z.strictObject({
      engine: z.literal("rea-sbpf-decoder"),
      text_section: z.string().nullable(),
      instruction_count: z.int().nonnegative(),
      unknown_opcodes: z.int().nonnegative(),
      call_sites: z.int().nonnegative(),
      exit_sites: z.int().nonnegative(),
      lddw_constants: z.int().nonnegative(),
      // detail-level: whether a code section was found to sweep, not a coverage verdict.
      coverage: z.enum(["complete", "no-text-section"]),
    }),
    handlers: z.array(
      z.strictObject({
        method: z.enum(["lddw-compare", "split-compare", "table-dispatch"]),
        /** Anchor discriminator bytes; null for table rows, whose identity is the slot label. */
        discriminator: discriminatorSchema.nullable(),
        label: z.string().nullable(),
        /**
         * Caller-supplied instruction name confirmed against the
         * discriminator (sha256("global:<name>")[..8]); null when no
         * supplied name matched — the row stays an unnamed candidate.
         */
        name: z.string().nullable(),
        constant_address: byteOffset.nullable(),
        constant_file_offset: byteOffset.nullable(),
        comparison_address: byteOffset.nullable(),
        comparison_addresses: z.array(byteOffset),
        branch: z.enum(["jeq", "jne"]).nullable(),
        branch_target: byteOffset,
        value_register: z.int().min(0).max(15).nullable(),
        constant_register: z.int().min(0).max(15).nullable(),
        table_address: byteOffset.nullable(),
        table_index: z.int().nonnegative().nullable(),
      }),
    ),
    dispatch: z.strictObject({
      total_candidates: z.int().nonnegative(),
      by_method: z.strictObject({
        "lddw-compare": z.int().nonnegative(),
        "split-compare": z.int().nonnegative(),
        "table-dispatch": z.int().nonnegative(),
      }),
      /** Register-indirect transfers matching no recovered table idiom. */
      computed_jumps_unresolved: z.int().nonnegative(),
    }),
    syscalls: z.strictObject({
      dynamic_symbols: z.array(z.string()),
      defined_symbols: z.int().nonnegative(),
      undefined_symbols: z.int().nonnegative(),
      /**
       * One row per immediate `call` site. A name is present only when it
       * verified: an ELF relocation naming the site, exactly one Murmur3
       * hash candidate, or an exact defined-symbol target.
       */
      call_sites: z.array(
        z.strictObject({
          address: byteOffset,
          immediate: z.int().nonnegative(),
          resolved_name: z.string().nullable(),
          basis: z.enum([
            "dynamic-symbol",
            "known-syscall-table",
            "symbol-table",
            "unresolved",
          ]),
          note: z.string().nullable(),
        }),
      ),
      resolved_calls: z.int().nonnegative(),
      unresolved_calls: z.int().nonnegative(),
    }),
    strings: z.strictObject({
      total: z.int().nonnegative(),
      relevant: z.array(
        z.strictObject({ value: z.string(), file_offset: byteOffset }),
      ),
    }),
    limitations: z.array(z.string()),
  })
  .superRefine((value, context) => {
    for (const [index, handler] of value.handlers.entries())
      if (
        handler.constant_file_offset !== null &&
        handler.constant_file_offset >= value.artifact.bytes
      )
        context.addIssue({
          code: "custom",
          path: ["handlers", index, "constant_file_offset"],
          message: "Handler constant lies outside the analyzed artifact.",
        });
    const seen = new Set<string>();
    for (const handler of value.handlers) {
      const key =
        handler.discriminator ??
        (handler.table_address === null
          ? null
          : `table:${String(handler.table_address)}:${String(handler.table_index)}`);
      if (key === null) continue;
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: ["handlers"],
          message:
            "Handler candidates must not repeat a discriminator or table slot.",
        });
      else seen.add(key);
    }
    const methodTotal =
      value.dispatch.by_method["lddw-compare"] +
      value.dispatch.by_method["split-compare"] +
      value.dispatch.by_method["table-dispatch"];
    if (
      methodTotal !== value.dispatch.total_candidates ||
      value.dispatch.total_candidates !== value.handlers.length
    )
      context.addIssue({
        code: "custom",
        path: ["dispatch"],
        message: "Dispatch coverage must account for every handler candidate.",
      });
  });

export type AnalyzeSolanaProgramInput = z.infer<
  typeof analyzeSolanaProgramInputSchema
>;
export type SolanaProgramAnalysis = z.infer<typeof solanaProgramAnalysisSchema>;

/** One batch item: the same source selection as the single-program input. */
const solanaProgramBatchItemSchema = z
  .strictObject({
    path: absoluteLocalPathStringSchema
      .optional()
      .describe("Absolute path to a caller-selected local sBPF ELF"),
    program_id: solanaPublicKeySchema
      .optional()
      .describe("Base58 program id to fetch through Solana JSON-RPC"),
    rpc_url: z
      .url()
      .optional()
      .describe("Solana JSON-RPC endpoint for this item's program-id intake"),
  })
  .superRefine((value, context) => {
    const hasPath = value.path !== undefined;
    const hasProgram = value.program_id !== undefined;
    if (hasPath === hasProgram)
      context.addIssue({
        code: "custom",
        path: ["path"],
        message:
          "Select exactly one program source per item: a local ELF path or a program id.",
      });
    if (hasPath && value.rpc_url !== undefined)
      context.addIssue({
        code: "custom",
        path: ["rpc_url"],
        message: "rpc_url applies only to program-id intake.",
      });
  });

/**
 * Batch analysis over the single-program workflow: every item is analyzed
 * in its own `<out_dir>/<name>/` directory with the single mode's
 * artifacts, and the batch writes one `index.json` summarizing all items.
 * Items are isolated — one bad item yields an error entry, never a failed
 * batch.
 */
export const analyzeSolanaProgramsInputSchema = z
  .strictObject({
    items: z
      .array(solanaProgramBatchItemSchema)
      .max(64)
      .optional()
      .describe("Programs to analyze; local ELF paths and program ids may mix"),
    dir: absoluteLocalPathStringSchema
      .optional()
      .describe(
        "Absolute path to a local directory whose .so files (sorted by name) join the batch after items",
      ),
    out_dir: absoluteLocalPathStringSchema.describe(
      "Directory receiving one subdirectory per item plus index.json",
    ),
    concurrency: z
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe("Maximum items analyzed at once (default 4, cap 8)"),
    handoff: z
      .boolean()
      .optional()
      .describe(
        "Write the deep-decompiler handoff artifact into every item directory",
      ),
    instruction_names: z
      .array(z.string().min(1).max(64))
      .max(512)
      .optional()
      .describe(
        "Caller-supplied Anchor instruction names confirmed against handler discriminators for every item",
      ),
  })
  .superRefine((value, context) => {
    if ((value.items?.length ?? 0) === 0 && value.dir === undefined)
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Select at least one item or a dir of .so captures.",
      });
  });

export type AnalyzeSolanaProgramsInput = z.infer<
  typeof analyzeSolanaProgramsInputSchema
>;
export type SolanaProgramBatchItem = z.infer<
  typeof solanaProgramBatchItemSchema
>;

/** The batch index: one entry per item, mirroring `<out_dir>/index.json`. */
export const solanaProgramBatchSchema = z.strictObject({
  out_dir: localPathStringSchema,
  index_path: localPathStringSchema,
  total: z.int().nonnegative(),
  succeeded: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  entries: z.array(
    z.strictObject({
      /** Item directory name under out_dir (derived from the source). */
      name: z.string(),
      /** The caller's source selection: the ELF path or the program id. */
      source: z.string(),
      status: z.enum(["ok", "error"]),
      sha256: digestSchema.nullable(),
      slot: byteOffset.nullable(),
      handler_candidates: z.int().nonnegative().nullable(),
      dispatch: solanaProgramAnalysisSchema.shape.dispatch.nullable(),
      analysis_path: localPathStringSchema.nullable(),
      error: z.string().nullable(),
    }),
  ),
});

export type SolanaProgramBatch = z.infer<typeof solanaProgramBatchSchema>;

/**
 * Credential-free provenance for a selected RPC endpoint: scheme and host
 * only. API keys commonly ride in userinfo, the path, or the query, so none
 * of those are retained; the full URL is used only for transport.
 */
export const solanaRpcEndpointProvenance = (url: string): string =>
  URL.parse(url)?.origin ?? "[unparseable endpoint]";
