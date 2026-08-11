import { z } from "zod";

/** PE/COFF section characteristics flags. */
export const sectionCharacteristicsSchema = z.object({
  /** Section contains executable code. */
  has_code: z.boolean().default(false),
  /** Section contains initialized data. */
  has_initialized_data: z.boolean().default(false),
  /** Section contains uninitialized data. */
  has_uninitialized_data: z.boolean().default(false),
  /** Section can be read. */
  readable: z.boolean().default(false),
  /** Section can be written. */
  writable: z.boolean().default(false),
  /** Section can be executed. */
  executable: z.boolean().default(false),
});

/** PE/COFF section header. */
export const peSectionSchema = z.strictObject({
  name: z.string().min(1),
  virtual_size: z.number().int().nonnegative(),
  virtual_address: z.number().int().nonnegative(),
  raw_size: z.number().int().nonnegative(),
  raw_offset: z.number().int().nonnegative(),
  characteristics: sectionCharacteristicsSchema,
});

/** PE import entry. */
export const peImportSchema = z.strictObject({
  dll: z.string().min(1),
  function_name: z.string().min(1),
  ordinal: z.number().int().nullable(),
  is_delay_import: z.boolean().default(false),
});

/** PE export entry. */
export const peExportSchema = z.strictObject({
  name: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  rva: z.number().int().nonnegative(),
  forwarder: z.string().nullable(),
});

/** PE/COFF resource entry. */
export const peResourceSchema = z.strictObject({
  type: z.string().min(1),
  name: z.string().nullable(),
  language: z.number().int().nullable(),
  rva: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
});

/** PE debug directory entry. */
export const peDebugEntrySchema = z.strictObject({
  type: z.string().min(1),
  rva: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  /** PDB GUID if this is a CodeView entry. */
  pdb_guid: z.string().nullable(),
  /** PDB age if this is a CodeView entry. */
  pdb_age: z.number().int().nullable(),
  /** PDB path if this is a CodeView entry. */
  pdb_path: z.string().nullable(),
});

/** TLS callback entry. */
export const peTlsCallbackSchema = z.strictObject({
  callback_rva: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
});

/** Architecture/machine type. */
export const peMachineTypeSchema = z.enum([
  "x86",
  "x64",
  "arm",
  "arm64",
  "ia64",
  "unknown",
]);
export type PeMachineType = z.infer<typeof peMachineTypeSchema>;

/** PE/COFF manifest for static inspection. */
export const peManifestSchema = z.strictObject({
  /** DOS header magic. */
  dos_magic: z.literal(0x5a4d),
  /** PE signature. */
  pe_signature: z.literal(0x00004550),
  /** Machine type. */
  machine: peMachineTypeSchema,
  /** Number of sections. */
  number_of_sections: z.number().int().positive(),
  /** Timestamp from the COFF header. */
  timestamp: z.number().int().nullable(),
  /** PE characteristics flags. */
  is_dll: z.boolean().default(false),
  is_executable: z.boolean().default(false),
  is_console: z.boolean().default(true),
  /** Entry point RVA. */
  entry_point: z.number().int().nonnegative(),
  /** Image base. */
  image_base: z.number().int().nonnegative(),
  /** Section alignment. */
  section_alignment: z.number().int().positive(),
  /** Subsystem version. */
  subsystem_version: z.string().nullable(),
  /** Sections. */
  sections: z.array(peSectionSchema).min(0).max(96),
  /** Imports. */
  imports: z.array(peImportSchema).default([]),
  /** Exports. */
  exports: z.array(peExportSchema).default([]),
  /** Resources. */
  resources: z.array(peResourceSchema).default([]),
  /** Debug directory entries. */
  debug_entries: z.array(peDebugEntrySchema).default([]),
  /** TLS callbacks. */
  tls_callbacks: z.array(peTlsCallbackSchema).default([]),
  /** Relocations count (not all entries). */
  relocations_count: z.number().int().nonnegative().default(0),
  /** Image file characteristics. */
  image_characteristics: z.array(z.string()).default([]),
});
export type PeManifest = z.infer<typeof peManifestSchema>;

/** Parse machine type from COFF machine field. */
export function parseMachineType(machine: number): PeMachineType {
  switch (machine) {
    case 0x014c:
      return "x86";
    case 0x8664:
      return "x64";
    case 0x01c0:
    case 0x01c4:
      return "arm";
    case 0xaa64:
      return "arm64";
    case 0x0200:
      return "ia64";
    default:
      return "unknown";
  }
}

/** Parse section characteristics flags. */
export function parseSectionCharacteristics(
  characteristics: number,
): z.infer<typeof sectionCharacteristicsSchema> {
  const IMAGE_SCN_CNT_CODE = 0x00000020;
  const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040;
  const IMAGE_SCN_CNT_UNINITIALIZED_DATA = 0x00000080;
  const IMAGE_SCN_MEM_READ = 0x40000000;
  const IMAGE_SCN_MEM_WRITE = 0x80000000;
  const IMAGE_SCN_MEM_EXECUTE = 0x20000000;

  return {
    has_code: (characteristics & IMAGE_SCN_CNT_CODE) !== 0,
    has_initialized_data:
      (characteristics & IMAGE_SCN_CNT_INITIALIZED_DATA) !== 0,
    has_uninitialized_data:
      (characteristics & IMAGE_SCN_CNT_UNINITIALIZED_DATA) !== 0,
    readable: (characteristics & IMAGE_SCN_MEM_READ) !== 0,
    writable: (characteristics & IMAGE_SCN_MEM_WRITE) !== 0,
    executable: (characteristics & IMAGE_SCN_MEM_EXECUTE) !== 0,
  };
}

/** Parse image characteristics flags. */
export function parseImageCharacteristics(characteristics: number): string[] {
  const IMAGE_DLL = 0x2000;
  const IMAGE_EXECUTABLE = 0x0002;
  const IMAGE_CONSOLE = 0x0003;
  const flags: string[] = [];
  if (characteristics & IMAGE_DLL) flags.push("DLL");
  if (characteristics & IMAGE_EXECUTABLE) flags.push("Executable");
  if ((characteristics & 0x0000000f) === IMAGE_CONSOLE) flags.push("Console");
  return flags;
}

/** Parse a PE debug directory type. */
export function parseDebugType(type: number): string {
  switch (type) {
    case 0:
      return "UNKNOWN";
    case 1:
      return "COFF";
    case 2:
      return "CODEVIEW";
    case 3:
      return "POGO";
    case 4:
      return "MISC";
    default:
      return "UNKNOWN";
  }
}

/** Check if a PE manifest has PDB debug info. */
export function hasPdbInfo(manifest: PeManifest): boolean {
  return manifest.debug_entries.some(
    (e) => e.pdb_guid !== null && e.pdb_path !== null,
  );
}

/** Get all imported DLLs from a PE manifest. */
export function getImportedDlls(manifest: PeManifest): string[] {
  return [...new Set(manifest.imports.map((i) => i.dll))];
}

/** Get all exported function names from a PE manifest. */
export function getExportedFunctions(manifest: PeManifest): string[] {
  return manifest.exports.map((e) => e.name);
}

/** Count executable sections. */
export function countExecutableSections(manifest: PeManifest): number {
  return manifest.sections.filter((s) => s.characteristics.executable).length;
}
