import { describe, expect, it } from "vitest";

import { parseLipoArchitectures } from "./lipo.js";

describe("lipo architecture facts", () => {
  it("normalizes symbolic CPU fields and arm64e capability bits", () => {
    const architectures = parseLipoArchitectures(`Fat header in: /bin/ls
fat_magic 0xcafebabe
nfat_arch 2
architecture x86_64
    cputype CPU_TYPE_X86_64
    cpusubtype CPU_SUBTYPE_X86_64_ALL
    capabilities 0x0
    offset 16384
    size 48112
    align 2^14 (16384)
architecture arm64e
    cputype CPU_TYPE_ARM64
    cpusubtype CPU_SUBTYPE_ARM64E
    capabilities PTR_AUTH_VERSION USERSPACE 0
    offset 65536
    size 89088
    align 2^14 (16384)
`);
    expect(architectures).toEqual([
      expect.objectContaining({
        name: "x86_64",
        cpu_type: "CPU_TYPE_X86_64",
        cpu_type_code: 0x01000007,
        cpu_subtype: "CPU_SUBTYPE_X86_64_ALL",
        cpu_subtype_code: 3,
        capabilities: "0x0",
        file_offset: 16384,
        size: 48112,
        alignment: 16384,
      }),
      expect.objectContaining({
        name: "arm64e",
        cpu_type: "CPU_TYPE_ARM64",
        cpu_type_code: 0x0100000c,
        cpu_subtype: "CPU_SUBTYPE_ARM64E",
        cpu_subtype_code: 0x80000002,
        capabilities: "PTR_AUTH_VERSION USERSPACE 0",
        file_offset: 65536,
        size: 89088,
        alignment: 16384,
      }),
    ]);
  });

  it("keeps unknown symbolic CPU values as source text without a code", () => {
    expect(
      parseLipoArchitectures(
        "architecture future\n cputype CPU_TYPE_FUTURE\n cpusubtype CPU_SUBTYPE_FUTURE\n offset 4096\n size 64\n align 2^12\n",
      ),
    ).toMatchObject([
      {
        cpu_type: "CPU_TYPE_FUTURE",
        cpu_type_code: null,
        cpu_subtype: "CPU_SUBTYPE_FUTURE",
        cpu_subtype_code: null,
      },
    ]);
  });
});
