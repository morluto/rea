import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

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
  "core_prpsinfo",
  "core_file",
  "core_siginfo",
  "core_auxv",
  "android_ident",
  "unknown",
] as const;
export type ElfNoteTypeName = (typeof ELF_NOTE_TYPE_NAMES)[number];

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

/** Map GNU n_type when the owner is GNU; other owners stay unknown. */
export const gnuNoteTypeName = (type: number): ElfNoteTypeName => {
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

/** Map CORE n_type when the owner is CORE; other types stay unknown. */
export const coreNoteTypeName = (type: number): ElfNoteTypeName => {
  switch (type) {
    case 3:
      return "core_prpsinfo";
    case 6:
      return "core_auxv";
    case 0x46494c45:
      return "core_file";
    case 0x53494749:
      return "core_siginfo";
    default:
      return "unknown";
  }
};

/** Map Android n_type when the owner is Android; other types stay unknown. */
export const androidNoteTypeName = (type: number): ElfNoteTypeName =>
  type === 1 ? "android_ident" : "unknown";

/** Complete bounded inspection of ELF PT_NOTE and SHT_NOTE tables. */
export const inspectElfNotesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
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

const coreFileMappingSchema = z.strictObject({
  start_address: z.string().regex(/^0x[0-9a-f]+$/),
  end_address: z.string().regex(/^0x[0-9a-f]+$/),
  file_offset_pages: z.string().regex(/^0x[0-9a-f]+$/),
  path: z.string(),
  path_hex: z.string().regex(/^[0-9a-f]*$/),
});

const coreFileSchema = z.strictObject({
  count: uint,
  page_size: uint,
  mappings: z.array(coreFileMappingSchema),
});

const corePrpsinfoSchema = z.strictObject({
  state: uint,
  pid: z.number().int(),
  ppid: z.number().int(),
  pgrp: z.number().int(),
  sid: z.number().int(),
  uid: uint,
  gid: uint,
  filename: z.string(),
  psargs: z.string(),
});

const coreSiginfoSchema = z.strictObject({
  signo: z.number().int(),
  code: z.number().int(),
  errno: z.number().int(),
});

const coreAuxvEntrySchema = z.strictObject({
  type: uint,
  type_name: z.string().nullable(),
  value: z.string().regex(/^0x[0-9a-f]+$/),
});

export const coreNoteSchema = z.strictObject({
  prpsinfo: corePrpsinfoSchema.nullable(),
  file: coreFileSchema.nullable(),
  siginfo: coreSiginfoSchema.nullable(),
  auxv: z.array(coreAuxvEntrySchema).nullable(),
});

const androidIdentSchema = z.strictObject({
  android_api: uint,
  ndk_version: z.string().nullable(),
  ndk_build_number: z.string().nullable(),
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
  core: coreNoteSchema.nullable(),
  android: androidIdentSchema.nullable(),
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
