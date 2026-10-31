import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { ELF_OBJECT_TYPE_NAMES } from "./elfNotes.js";

const uint = z.number().int().min(0).max(0xffffffff);
const range = z.strictObject({ offset: uint, bytes: uint });

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_ELF_DEPENDENCY_FILE_BYTES = 536870912;
/** Hard ceiling on DT_NEEDED entries examined in one image. */
export const MAX_INSPECT_ELF_DEPENDENCY_NEEDED = 65536;
/** Hard ceiling on GNU version requirement and definition records. */
export const MAX_INSPECT_ELF_DEPENDENCY_VERSIONS = 65536;
/** Hard ceiling on undefined dynamic symbols examined as imports. */
export const MAX_INSPECT_ELF_DEPENDENCY_IMPORTS = 262144;

/** DT_FLAGS bits decoded by name. Unrecognized bits stay numeric. */
export const DF_FLAG_BITS = [
  [0x00000001, "ORIGIN"],
  [0x00000002, "SYMBOLIC"],
  [0x00000004, "TEXTREL"],
  [0x00000008, "BIND_NOW"],
  [0x00000010, "STATIC_TLS"],
] as const;

/** DT_FLAGS_1 bits decoded by name. Unrecognized bits stay numeric. */
export const DF_1_FLAG_BITS = [
  [0x00000001, "NOW"],
  [0x00000002, "GLOBAL"],
  [0x00000004, "GROUP"],
  [0x00000008, "NODELETE"],
  [0x00000010, "LOADFLTR"],
  [0x00000020, "INITFIRST"],
  [0x00000040, "NOOPEN"],
  [0x00000080, "ORIGIN"],
  [0x00000100, "DIRECT"],
  [0x00000200, "TRANS"],
  [0x00000400, "INTERPOSE"],
  [0x00000800, "NODEFLIB"],
  [0x00001000, "NODUMP"],
  [0x00002000, "CONFALT"],
  [0x00004000, "ENDFILTEE"],
  [0x00008000, "DISPRELDNE"],
  [0x00010000, "DISPRELPND"],
  [0x00020000, "NODIRECT"],
  [0x00040000, "IGNMULDEF"],
  [0x00080000, "NOKSYMS"],
  [0x00100000, "NOHDR"],
  [0x00200000, "EDITED"],
  [0x00400000, "NORELOC"],
  [0x00800000, "SYMINTPOSE"],
  [0x01000000, "GLOBAUDIT"],
  [0x02000000, "SINGLETON"],
  [0x04000000, "STUB"],
  [0x08000000, "PIE"],
  [0x10000000, "KMOD"],
  [0x20000000, "WEAKFILTER"],
  [0x40000000, "NOCOMMON"],
] as const;

export const ELF_DEPENDENCY_SEARCH_TOKENS = [
  "$ORIGIN",
  "$LIB",
  "$PLATFORM",
] as const;

export const ELF_DEPENDENCY_ISSUE_CODES = [
  "malformed_entry",
  "name_unreadable",
  "table_unavailable",
  "version_unresolved",
] as const;

const searchTokenSchema = z.enum(ELF_DEPENDENCY_SEARCH_TOKENS);

/** Named DT_FLAGS / DT_FLAGS_1 bits plus any bits the table did not name. */
export const decodeElfDynamicFlags = (
  raw: number,
  bits: readonly (readonly [number, string])[],
): { raw: number; names: string[]; unrecognized: number } => {
  const names: string[] = [];
  let recognized = 0;
  for (const [mask, name] of bits) {
    if ((raw & mask) !== 0) {
      names.push(name);
      recognized |= mask;
    }
  }
  return { raw, names, unrecognized: (raw >>> 0) - recognized };
};

/** Split a DT_RPATH / DT_RUNPATH value on ':' without dropping empty entries. */
export const splitElfSearchPath = (raw: string): string[] => raw.split(":");

/** Report $ORIGIN / $LIB / $PLATFORM tokens as written, including ${...} forms. */
export const elfSearchPathTokens = (
  raw: string,
): (typeof ELF_DEPENDENCY_SEARCH_TOKENS)[number][] => {
  const found: (typeof ELF_DEPENDENCY_SEARCH_TOKENS)[number][] = [];
  const seen = new Set<string>();
  const pattern = /\$(?:\{(ORIGIN|LIB|PLATFORM)\}|(ORIGIN|LIB|PLATFORM)\b)/g;
  for (const match of raw.matchAll(pattern)) {
    const name = match[1] ?? match[2];
    if (name === undefined) continue;
    const token = `$${name}` as (typeof ELF_DEPENDENCY_SEARCH_TOKENS)[number];
    if (seen.has(token)) continue;
    seen.add(token);
    found.push(token);
  }
  return found;
};

const VERSION_NAME = /^(.*)_([0-9]+(?:\.[0-9]+)*)$/u;

const versionParts = (value: string): bigint[] =>
  value.split(".").map((part) => BigInt(part));

const compareVersionParts = (left: bigint[], right: bigint[]): number => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0n;
    const b = right[index] ?? 0n;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
};

/**
 * Highest GNU-style NAME_x.y string per namespace. Comparison is exact integer
 * order on the dotted suffix; names that do not match, or that have an empty
 * namespace, stay out of the derived set while their requirements remain.
 */
export const derivedElfVersionMaxima = (
  names: readonly string[],
): { namespace: string; maximum: string; evidence_kind: "derived" }[] => {
  const best = new Map<string, { maximum: string; parts: bigint[] }>();
  for (const name of names) {
    const match = VERSION_NAME.exec(name);
    if (match === null || match[1] === undefined || match[2] === undefined)
      continue;
    const namespace = match[1];
    if (namespace.length === 0) continue;
    const parts = versionParts(match[2]);
    const current = best.get(namespace);
    if (current === undefined || compareVersionParts(parts, current.parts) > 0)
      best.set(namespace, { maximum: name, parts });
  }
  return [...best.entries()].map(([namespace, value]) => ({
    namespace,
    maximum: value.maximum,
    evidence_kind: "derived" as const,
  }));
};

/** Complete bounded inspection of one loadable ELF dynamic-dependency inventory. */
export const inspectElfDependenciesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to an ELF32/ELF64 ET_EXEC or ET_DYN image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_ELF_DEPENDENCY_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_needed: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_ELF_DEPENDENCY_NEEDED)
    .default(1024)
    .describe(
      "Maximum DT_NEEDED entries to examine; exceeding the budget fails without partial success",
    ),
  max_versions: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_ELF_DEPENDENCY_VERSIONS)
    .default(4096)
    .describe(
      "Maximum GNU version requirement and definition records to examine; exceeding the budget fails without partial success",
    ),
  max_imports: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_ELF_DEPENDENCY_IMPORTS)
    .default(65536)
    .describe(
      "Maximum undefined dynamic symbols to examine as imports; exceeding the budget fails without partial success",
    ),
});
export type InspectElfDependenciesInput = z.infer<
  typeof inspectElfDependenciesInputSchema
>;

const flagsSchema = z.strictObject({
  raw: uint,
  names: z.array(z.string().min(1)),
  unrecognized: uint,
});

const searchPathSchema = z.strictObject({
  raw: z.string(),
  entries: z.array(z.string()),
  tokens: z.array(searchTokenSchema),
});

const neededEntrySchema = z.strictObject({
  index: uint,
  name: z.string().min(1).nullable(),
  name_offset: uint,
});

const versionNeedSchema = z.strictObject({
  name: z.string().min(1).nullable(),
  hash: uint,
  flags: z.strictObject({ weak: z.boolean() }),
  index: z.number().int().min(0).max(0x7fff),
});

const versionNeedFileSchema = z.strictObject({
  file: z.string().min(1).nullable(),
  versions: z.array(versionNeedSchema),
});

const versionDefinitionSchema = z.strictObject({
  name: z.string().min(1).nullable(),
  index: z.number().int().min(0).max(0x7fff),
  base: z.boolean(),
});

const derivedMaximumSchema = z.strictObject({
  namespace: z.string().min(1),
  maximum: z.string().min(1),
  evidence_kind: z.literal("derived"),
});

const importVersionSchema = z.strictObject({
  index: z.number().int().min(0).max(0x7fff),
  hidden: z.boolean(),
  name: z.string().min(1).nullable(),
  file: z.string().min(1).nullable(),
  status: z.enum(["unversioned", "resolved", "unknown"]),
});

const importSchema = z.strictObject({
  index: uint,
  name: z.string().min(1).nullable(),
  binding: z.enum(["local", "global", "weak", "unique", "other"]),
  type: z.enum(["function", "object", "ifunc", "tls", "other"]),
  version: importVersionSchema.nullable(),
});

const issueSchema = z.strictObject({
  code: z.enum(ELF_DEPENDENCY_ISSUE_CODES),
  location: z.string().min(1).nullable(),
  message: z.string().min(1),
});

const coverageSchema = z.strictObject({
  status: z.enum(["complete", "partial"]),
  reason: z.string().min(1).nullable(),
  examined_needed: uint,
  examined_versions: uint,
  examined_imports: uint,
});

/** Static load-time dependency inventory of one ELF ET_EXEC/ET_DYN image. */
export const elfDependenciesReportSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.enum(["elf32", "elf64"]),
  byte_order: z.enum(["little", "big"]),
  machine: uint,
  architecture: z.string().min(1),
  type: uint,
  type_name: z.enum(ELF_OBJECT_TYPE_NAMES),
  interpreter: z.strictObject({
    status: z.enum(["present", "absent", "unreadable"]),
    path: z.string().min(1).nullable(),
    location: range.nullable(),
  }),
  dynamic: z.strictObject({
    status: z.enum(["present", "absent"]),
    location: range.nullable(),
    soname: z
      .strictObject({
        name: z.string().min(1).nullable(),
        name_offset: uint,
      })
      .nullable(),
    rpath: searchPathSchema.nullable(),
    runpath: searchPathSchema.nullable(),
    flags: flagsSchema.nullable(),
    flags_1: flagsSchema.nullable(),
  }),
  needed: z.array(neededEntrySchema),
  version_requirements: z.strictObject({
    status: z.enum(["present", "absent", "unreadable"]),
    location: range.nullable(),
    files: z.array(versionNeedFileSchema),
  }),
  version_definitions: z.strictObject({
    status: z.enum(["present", "absent", "unreadable"]),
    location: range.nullable(),
    names: z.array(versionDefinitionSchema),
  }),
  derived_version_maxima: z.array(derivedMaximumSchema),
  imports: z.array(importSchema),
  coverage: coverageSchema,
  issues: z.array(issueSchema),
  limitations: z.array(z.string().min(1)),
});

export const elfDependenciesSchema = elfDependenciesReportSchema.superRefine(
  (value, context) => {
    if (value.coverage.examined_needed !== value.needed.length)
      context.addIssue({
        code: "custom",
        path: ["coverage", "examined_needed"],
        message:
          "Needed coverage count must equal the retained DT_NEEDED rows.",
      });
    if (value.coverage.examined_imports !== value.imports.length)
      context.addIssue({
        code: "custom",
        path: ["coverage", "examined_imports"],
        message:
          "Import coverage count must equal the retained undefined-symbol rows.",
      });
    if (value.coverage.status === "complete" && value.issues.length > 0)
      context.addIssue({
        code: "custom",
        path: ["coverage", "status"],
        message: "Complete coverage cannot retain table issues.",
      });
    if (value.coverage.status === "partial" && value.issues.length === 0)
      context.addIssue({
        code: "custom",
        path: ["coverage", "status"],
        message: "Partial coverage requires at least one table issue.",
      });
    if (value.dynamic.status === "absent") {
      if (
        value.dynamic.location !== null ||
        value.dynamic.soname !== null ||
        value.dynamic.rpath !== null ||
        value.dynamic.runpath !== null ||
        value.dynamic.flags !== null ||
        value.dynamic.flags_1 !== null ||
        value.needed.length !== 0
      )
        context.addIssue({
          code: "custom",
          path: ["dynamic"],
          message:
            "An absent PT_DYNAMIC inventory cannot retain dynamic entries.",
        });
    } else if (value.dynamic.location === null)
      context.addIssue({
        code: "custom",
        path: ["dynamic", "location"],
        message: "A present dynamic segment must retain its file range.",
      });
  },
);
export type ElfDependencies = z.infer<typeof elfDependenciesSchema>;
export type ElfDependencyNeeded = z.infer<typeof neededEntrySchema>;
export type ElfDependencyImport = z.infer<typeof importSchema>;
export type ElfDependencyIssue = z.infer<typeof issueSchema>;
export type ElfVersionNeedFile = z.infer<typeof versionNeedFileSchema>;
export type ElfVersionDefinition = z.infer<typeof versionDefinitionSchema>;
