/** loader.h `LC_REQ_DYLD`: dyld must understand a command carrying this bit. */
export const LC_REQ_DYLD = 0x80000000;

/**
 * Mach-O load-command codes from `<mach-o/loader.h>`, keyed by their header
 * names. This is the one table of these values; parsers and projections import
 * it instead of redefining the codes they read.
 */
export const LC = {
  SEGMENT: 0x1,
  SYMTAB: 0x2,
  SYMSEG: 0x3,
  THREAD: 0x4,
  UNIXTHREAD: 0x5,
  LOADFVMLIB: 0x6,
  IDFVMLIB: 0x7,
  IDENT: 0x8,
  FVMFILE: 0x9,
  PREPAGE: 0xa,
  DYSYMTAB: 0xb,
  LOAD_DYLIB: 0xc,
  ID_DYLIB: 0xd,
  LOAD_DYLINKER: 0xe,
  ID_DYLINKER: 0xf,
  PREBOUND_DYLIB: 0x10,
  ROUTINES: 0x11,
  SUB_FRAMEWORK: 0x12,
  SUB_UMBRELLA: 0x13,
  SUB_CLIENT: 0x14,
  SUB_LIBRARY: 0x15,
  TWOLEVEL_HINTS: 0x16,
  PREBIND_CKSUM: 0x17,
  LOAD_WEAK_DYLIB: 0x80000018,
  SEGMENT_64: 0x19,
  ROUTINES_64: 0x1a,
  UUID: 0x1b,
  RPATH: 0x8000001c,
  CODE_SIGNATURE: 0x1d,
  SEGMENT_SPLIT_INFO: 0x1e,
  REEXPORT_DYLIB: 0x8000001f,
  LAZY_LOAD_DYLIB: 0x20,
  ENCRYPTION_INFO: 0x21,
  DYLD_INFO: 0x22,
  DYLD_INFO_ONLY: 0x80000022,
  LOAD_UPWARD_DYLIB: 0x80000023,
  VERSION_MIN_MACOSX: 0x24,
  VERSION_MIN_IPHONEOS: 0x25,
  FUNCTION_STARTS: 0x26,
  DYLD_ENVIRONMENT: 0x27,
  MAIN: 0x80000028,
  DATA_IN_CODE: 0x29,
  SOURCE_VERSION: 0x2a,
  DYLIB_CODE_SIGN_DRS: 0x2b,
  ENCRYPTION_INFO_64: 0x2c,
  LINKER_OPTION: 0x2d,
  LINKER_OPTIMIZATION_HINT: 0x2e,
  VERSION_MIN_TVOS: 0x2f,
  VERSION_MIN_WATCHOS: 0x30,
  NOTE: 0x31,
  BUILD_VERSION: 0x32,
  DYLD_EXPORTS_TRIE: 0x80000033,
  DYLD_CHAINED_FIXUPS: 0x80000034,
  FILESET_ENTRY: 0x80000035,
  ATOM_INFO: 0x36,
  FUNCTION_VARIANTS: 0x37,
  FUNCTION_VARIANT_FIXUPS: 0x38,
  TARGET_TRIPLE: 0x39,
  LAZY_LOAD_DYLIB_INFO: 0x3a,
} as const;

const NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(LC).map(([name, code]) => [code, `LC_${name}`]),
);

/** The `<mach-o/loader.h>` name of a known load-command code, such as `LC_UUID`. */
export const machoLoadCommandName = (code: number): string | undefined =>
  NAMES.get(code);
