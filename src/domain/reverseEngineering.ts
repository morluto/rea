import { z } from "zod";
import { commandEvidenceDetailSchema } from "./commandObservation.js";
import type { EvidenceProvider } from "./evidence.js";
import { localPathStringSchema } from "./localPath.js";
import { RAW_BINARY_ENTRY_POINT } from "./rawBinary.js";

/** Omitted one-shot objdump/rizin wall clock. Preflight shares it; the command gets it again. */
export const DEFAULT_REVERSE_COMMAND_TIMEOUT_MS = 120_000;
/** Node timer ceiling. Larger deadlines would be clamped instead of honored. */
export const MAX_REVERSE_COMMAND_TIMEOUT_MS = 2_147_483_647;

/** Per-call deadline for one-shot objdump and rizin commands. */
export const reverseCommandTimeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_REVERSE_COMMAND_TIMEOUT_MS)
  .exactOptional()
  .describe(
    "Wall-clock budget in milliseconds. Target preflight shares one budget across stat and digest, and the one-shot command receives that budget again (default 120000 each). Omitted means 120000. Applies on the next call. Does not raise the 16 MiB combined output cap, Ghidra or Hopper startup deadlines, or debugger session deadlines.",
  );

const commandTimeoutMsField = {
  command_timeout_ms: reverseCommandTimeoutSchema,
};

export const OBJDUMP_ARTIFACT_OPERATIONS = [
  "file_headers",
  "section_headers",
  "symbols",
  "relocations",
  "dwarf",
  "disassemble",
  "disassemble_all",
] as const;

const objdumpArtifactInputSchema = z
  .object({
    path: localPathStringSchema,
    operation: z.enum(OBJDUMP_ARTIFACT_OPERATIONS).exclude(["disassemble"]),
    follow_debug_links: z.boolean().default(false),
    ...commandTimeoutMsField,
  })
  .strict();

const objdumpDisassemblyInputSchema = objdumpArtifactInputSchema.extend({
  operation: z.literal("disassemble"),
  symbol: z
    .string()
    .min(1)
    .regex(/^[^\x00]*$/u)
    // Keep UTF-16 checks out of patterns consumed by scalar Unicode engines.
    .refine(
      (symbol) => !/[\uD800-\uDFFF]/u.test(symbol),
      "Symbol must be well-formed Unicode.",
    )
    .describe(
      "Native symbol to disassemble, expressed as well-formed Unicode. Matching and symbol boundaries follow the selected executable; omitted means all code sections.",
    )
    .optional(),
});

const objdumpArchitecturesInputSchema = z.strictObject({
  operation: z.literal("architectures"),
  ...commandTimeoutMsField,
});

/** Caller-selected native selection and independent Evidence delivery. */
export const objdumpInputSchema = z.discriminatedUnion("operation", [
  objdumpArtifactInputSchema.extend({ detail: commandEvidenceDetailSchema }),
  objdumpDisassemblyInputSchema.extend({ detail: commandEvidenceDetailSchema }),
  objdumpArchitecturesInputSchema.extend({
    detail: commandEvidenceDetailSchema,
  }),
]);

// Rizin owns its arch and CPU vocabulary, and the plugins differ between
// builds, so REA checks only the spelling. Rizin sets no length limit.
const rizinNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.+\-]*$/u,
    "must be a Rizin name: letters, digits, '_', '.', '+' or '-', starting with a letter or digit",
  );

/** Caller-selected Rizin command against one local artifact. */
export const rizinInputSchema = z
  .object({
    path: localPathStringSchema,
    command: z
      .string()
      .min(1)
      .refine(
        (value) => !/[\r\n\u0000]/u.test(value),
        "A single command line is required",
      ),
    asm_arch: rizinNameSchema
      .exactOptional()
      .describe(
        "Rizin arch plugin, passed as -a, such as arm. Plugins differ between builds; e asm.arch=? lists them.",
      ),
    // Rizin's widest decoders are 64-bit.
    asm_bits: z
      .number()
      .int()
      .min(1)
      .max(64)
      .exactOptional()
      .describe(
        "Rizin asm.bits, passed as -b, such as 16 for Thumb. Omitted, Rizin's default applies.",
      ),
    asm_cpu: rizinNameSchema
      .exactOptional()
      .describe(
        "Rizin asm.cpu, passed as -e asm.cpu=, such as cortexm; e asm.cpu=? lists those of the selected arch.",
      ),
    base_address: z
      .string()
      .regex(RAW_BINARY_ENTRY_POINT, {
        message: "base_address must be a hexadecimal address of the form 0x…",
      })
      .exactOptional()
      .describe(
        "Address of file offset 0. REA passes -n and -m, so Rizin maps the file there as a raw image, reads no format headers, and keeps its default decoder unless asm_arch and asm_bits select one.",
      ),
    ...commandTimeoutMsField,
  })
  .strict();

export type ObjdumpSelection =
  | z.input<typeof objdumpArtifactInputSchema>
  | z.input<typeof objdumpDisassemblyInputSchema>
  | z.input<typeof objdumpArchitecturesInputSchema>;
export type RizinInput = z.output<typeof rizinInputSchema>;

/** A provider's reading of the version banner its selected executable printed. */
export interface ProviderToolIdentification {
  readonly identity: EvidenceProvider;
  readonly limitations: readonly string[];
}

/** Arguments that print a version banner, and the provider's reading of it. */
export interface ProviderVersionProbe {
  readonly arguments: readonly string[];
  /**
   * Reads the banner: the first stdout line, trimmed and bounded by the
   * service. Undefined means the banner identifies no tool.
   */
  readonly identify: (banner: string) => ProviderToolIdentification | undefined;
  /** The limitation recorded when no banner identified the tool, whose identity is then assumed. */
  readonly assumedIdentity: string;
}
