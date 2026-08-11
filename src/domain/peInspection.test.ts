import { describe, expect, it } from "vitest";

import {
  countExecutableSections,
  getExportedFunctions,
  getImportedDlls,
  hasPdbInfo,
  parseDebugType,
  parseImageCharacteristics,
  parseMachineType,
  parseSectionCharacteristics,
  peManifestSchema,
  type PeManifest,
} from "./peInspection.js";

const validManifest: PeManifest = {
  dos_magic: 0x5a4d,
  pe_signature: 0x00004550,
  machine: "x64",
  number_of_sections: 3,
  timestamp: 0x12345678,
  is_dll: false,
  is_executable: true,
  is_console: true,
  entry_point: 0x1000,
  image_base: 0x400000,
  section_alignment: 0x1000,
  subsystem_version: "10.0",
  sections: [
    {
      name: ".text",
      virtual_size: 0x1000,
      virtual_address: 0x1000,
      raw_size: 0x1000,
      raw_offset: 0x400,
      characteristics: {
        has_code: true,
        has_initialized_data: false,
        has_uninitialized_data: false,
        readable: true,
        writable: false,
        executable: true,
      },
    },
    {
      name: ".data",
      virtual_size: 0x500,
      virtual_address: 0x2000,
      raw_size: 0x500,
      raw_offset: 0x1400,
      characteristics: {
        has_code: false,
        has_initialized_data: true,
        has_uninitialized_data: false,
        readable: true,
        writable: true,
        executable: false,
      },
    },
    {
      name: ".rdata",
      virtual_size: 0x200,
      virtual_address: 0x3000,
      raw_size: 0x200,
      raw_offset: 0x1900,
      characteristics: {
        has_code: false,
        has_initialized_data: true,
        has_uninitialized_data: false,
        readable: true,
        writable: false,
        executable: false,
      },
    },
  ],
  imports: [
    {
      dll: "KERNEL32.DLL",
      function_name: "CreateFileW",
      ordinal: null,
      is_delay_import: false,
    },
    {
      dll: "KERNEL32.DLL",
      function_name: "WriteFile",
      ordinal: null,
      is_delay_import: false,
    },
    {
      dll: "USER32.DLL",
      function_name: "MessageBoxW",
      ordinal: 100,
      is_delay_import: false,
    },
  ],
  exports: [
    { name: "DllMain", ordinal: 1, rva: 0x1000, forwarder: null },
    { name: "MyFunction", ordinal: 2, rva: 0x1050, forwarder: null },
  ],
  resources: [
    { type: "RT_VERSION", name: "1", language: 0x0409, rva: 0x4000, size: 100 },
  ],
  debug_entries: [
    {
      type: "CODEVIEW",
      rva: 0x5000,
      size: 100,
      pdb_guid: "AABBCCDD-EEFF-GGHH-IIJJ-KKLLMMNNOOPP",
      pdb_age: 1,
      pdb_path: "C:\\src\\app.pdb",
    },
  ],
  tls_callbacks: [{ callback_rva: 0x6000, index: 0 }],
  relocations_count: 50,
  image_characteristics: ["Executable", "Console"],
};

describe("PE/COFF static inspection", () => {
  it("parses machine types", () => {
    expect(parseMachineType(0x014c)).toBe("x86");
    expect(parseMachineType(0x8664)).toBe("x64");
    expect(parseMachineType(0x01c0)).toBe("arm");
    expect(parseMachineType(0xaa64)).toBe("arm64");
    expect(parseMachineType(0x0200)).toBe("ia64");
    expect(parseMachineType(0xffff)).toBe("unknown");
  });

  it("parses section characteristics", () => {
    const CODE = 0x00000020;
    const READ = 0x40000000;
    const EXECUTE = 0x20000000;
    const result = parseSectionCharacteristics(CODE | READ | EXECUTE);
    expect(result.has_code).toBe(true);
    expect(result.readable).toBe(true);
    expect(result.executable).toBe(true);
    expect(result.writable).toBe(false);
  });

  it("parses image characteristics", () => {
    const DLL = 0x2000;
    const EXEC = 0x0002;
    const flags = parseImageCharacteristics(DLL | EXEC);
    expect(flags).toContain("DLL");
    expect(flags).toContain("Executable");
  });

  it("parses debug types", () => {
    expect(parseDebugType(2)).toBe("CODEVIEW");
    expect(parseDebugType(1)).toBe("COFF");
    expect(parseDebugType(99)).toBe("UNKNOWN");
  });

  it("validates a well-formed manifest", () => {
    const result = peManifestSchema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it("detects PDB info", () => {
    expect(hasPdbInfo(validManifest)).toBe(true);
    const withoutPdb: PeManifest = {
      ...validManifest,
      debug_entries: [
        {
          type: "COFF",
          rva: 0x5000,
          size: 100,
          pdb_guid: null,
          pdb_age: null,
          pdb_path: null,
        },
      ],
    };
    expect(hasPdbInfo(withoutPdb)).toBe(false);
  });

  it("gets imported DLLs", () => {
    const dlls = getImportedDlls(validManifest);
    expect(dlls).toHaveLength(2);
    expect(dlls).toContain("KERNEL32.DLL");
    expect(dlls).toContain("USER32.DLL");
  });

  it("gets exported functions", () => {
    const exports = getExportedFunctions(validManifest);
    expect(exports).toHaveLength(2);
    expect(exports).toContain("DllMain");
    expect(exports).toContain("MyFunction");
  });

  it("counts executable sections", () => {
    expect(countExecutableSections(validManifest)).toBe(1);
  });
});
