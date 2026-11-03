import { z } from "zod";

import { digestSchema } from "../digests.js";
import { jsonValueSchema } from "../jsonValue.js";
import { localPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const range = z.strictObject({ offset: uint, bytes: uint });

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_ELF_NOTE_FILE_BYTES = 536870912;
/** Hard ceiling on decoded note entries across every declared table. */
export const MAX_INSPECT_ELF_NOTE_ENTRIES = 256;

export const ELF_NOTE_TYPE_NAMES = [
  "gnu_abi_tag",
  "gnu_hwcap",
  "gnu_build_id",
  "gnu_gold_version",
  "gnu_property",
  "fdo_packaging_metadata",
  "fdo_dlopen_metadata",
  "unknown",
] as const;
export type ElfNoteTypeName = (typeof ELF_NOTE_TYPE_NAMES)[number];

/** UAPI package metadata for executable files (`.note.package`). */
export const FDO_PACKAGING_METADATA = 0xcafe1a7e;
/** UAPI ELF dlopen metadata (`.note.dlopen`). */
export const FDO_DLOPEN_METADATA = 0x407c0c0a;

export const ELF_OBJECT_TYPE_NAMES = [
  "relocatable",
  "executable",
  "shared",
  "core",
  "unknown",
] as const;
export type ElfObjectTypeName = (typeof ELF_OBJECT_TYPE_NAMES)[number];

/** Map e_type without inventing names for unknown object kinds. */
export const elfObjectTypeName = (type: number): ElfObjectTypeName => {
  switch (type) {
    case 1:
      return "relocatable";
    case 2:
      return "executable";
    case 3:
      return "shared";
    case 4:
      return "core";
    default:
      return "unknown";
  }
};

/** Map n_type within its owner's namespace; other owners and types stay unknown. */
export const elfNoteTypeName = (
  owner: string,
  type: number,
): ElfNoteTypeName => {
  if (owner === "FDO") {
    if (type === FDO_PACKAGING_METADATA) return "fdo_packaging_metadata";
    if (type === FDO_DLOPEN_METADATA) return "fdo_dlopen_metadata";
    return "unknown";
  }
  if (owner !== "GNU") return "unknown";
  switch (type) {
    case 1:
      return "gnu_abi_tag";
    case 2:
      return "gnu_hwcap";
    case 3:
      return "gnu_build_id";
    case 4:
      return "gnu_gold_version";
    case 5:
      return "gnu_property";
    default:
      return "unknown";
  }
};

/** Complete bounded inspection of ELF PT_NOTE and SHT_NOTE tables. */
export const inspectElfNotesInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to an ELF image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_ELF_NOTE_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_ELF_NOTE_ENTRIES)
    .default(32)
    .describe(
      "Maximum note entries to examine across every table; exceeding the budget fails without partial success",
    ),
});

const gnuAbiTagSchema = z.strictObject({
  os: uint,
  os_name: z.string().nullable(),
  major: uint,
  minor: uint,
  subminor: uint,
});

const noteEntrySchema = z.strictObject({
  index: uint,
  table_kind: z.enum(["program", "section"]),
  table_index: uint,
  location: range,
  namesz: uint,
  descsz: uint,
  type: uint,
  type_name: z.enum(ELF_NOTE_TYPE_NAMES),
  owner: z.string(),
  owner_bytes_hex: z.string().regex(/^[0-9a-f]*$/),
  descriptor: z.strictObject({
    location: range,
    bytes: uint,
    sha256: digestSchema,
    hex: z
      .string()
      .regex(/^[0-9a-f]*$/)
      .nullable(),
  }),
  gnu: z
    .strictObject({
      build_id_hex: z
        .string()
        .regex(/^[0-9a-f]*$/)
        .nullable(),
      abi_tag: gnuAbiTagSchema.nullable(),
      gold_version: z.string().nullable(),
    })
    .nullable(),
  /**
   * Decoded FDO packaging or dlopen metadata. `metadata` is the descriptor's
   * JSON object or array; `issue` explains why it is null.
   */
  fdo: z
    .strictObject({
      metadata: jsonValueSchema.nullable(),
      issue: z.string().nullable(),
    })
    .nullable(),
});

/** Observed ELF note tables; absence is an empty list, not proof notes never existed. */
export const elfNotesSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.enum(["elf32", "elf64"]),
  byte_order: z.enum(["little", "big"]),
  machine: uint,
  type: uint,
  type_name: z.enum(ELF_OBJECT_TYPE_NAMES),
  tables: z.array(
    z.strictObject({
      kind: z.enum(["program", "section"]),
      index: uint,
      name: z.string().nullable(),
      location: range,
      alignment: uint,
    }),
  ),
  entries: z.array(noteEntrySchema),
  coverage: z.strictObject({
    status: z.literal("complete"),
    examined_tables: uint,
    examined_entries: uint,
  }),
  limitations: z.array(z.string()),
});

export type ElfNotes = z.infer<typeof elfNotesSchema>;
export type InspectElfNotesInput = z.infer<typeof inspectElfNotesInputSchema>;
