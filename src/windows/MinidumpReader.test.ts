import { describe, expect, it } from "vitest";
import {
  isMinidump,
  MAX_MINIDUMP_STREAMS,
  MAX_MINIDUMP_STRING_BYTES,
  parseMinidump,
} from "./MinidumpReader.js";

const createMockMinidump = (): Buffer => {
  const buf = Buffer.alloc(1024, 0);

  // 1. Minidump Header (32 bytes)
  buf.writeUInt32LE(0x504d444d, 0); // "MDMP"
  buf.writeUInt32LE(0x0000a793, 4); // version
  buf.writeUInt32LE(3, 8); // 3 streams
  const streamDirRva = 32;
  buf.writeUInt32LE(streamDirRva, 12);
  buf.writeUInt32LE(1680000000, 20); // timestamp

  // 2. Stream Directory (3 entries * 12 bytes = 36 bytes: 32..68)
  const sysInfoRva = 72;
  const sysInfoSize = 32;
  buf.writeUInt32LE(7, streamDirRva); // SystemInfoStream (7)
  buf.writeUInt32LE(sysInfoSize, streamDirRva + 4);
  buf.writeUInt32LE(sysInfoRva, streamDirRva + 8);

  const exceptionRva = 120;
  const exceptionSize = 32;
  buf.writeUInt32LE(6, streamDirRva + 12); // ExceptionStream (6)
  buf.writeUInt32LE(exceptionSize, streamDirRva + 16);
  buf.writeUInt32LE(exceptionRva, streamDirRva + 20);

  const moduleListRva = 160;
  const moduleListSize = 120;
  buf.writeUInt32LE(4, streamDirRva + 24); // ModuleListStream (4)
  buf.writeUInt32LE(moduleListSize, streamDirRva + 28);
  buf.writeUInt32LE(moduleListRva, streamDirRva + 32);

  // 3. SystemInfo Stream payload (at 72)
  buf.writeUInt16LE(9, sysInfoRva); // x86-64 (AMD64)
  buf.writeUInt8(8, sysInfoRva + 6); // 8 CPUs
  buf.writeUInt32LE(10, sysInfoRva + 8); // major = 10
  buf.writeUInt32LE(0, sysInfoRva + 12); // minor = 0
  buf.writeUInt32LE(19045, sysInfoRva + 16); // build = 19045

  // 4. Exception Stream payload (at 120)
  buf.writeUInt32LE(4242, exceptionRva); // threadId = 4242
  buf.writeUInt32LE(0xc0000005, exceptionRva + 8); // code = STATUS_ACCESS_VIOLATION
  buf.writeUInt32LE(0, exceptionRva + 12); // flags
  buf.writeBigUInt64LE(0x7ffe12345678n, exceptionRva + 24); // address

  // 5. ModuleList Stream payload (at 160)
  buf.writeUInt32LE(1, moduleListRva); // 1 module
  const modEntryOffset = moduleListRva + 4;
  buf.writeBigUInt64LE(0x7ffe00000000n, modEntryOffset); // BaseOfImage
  buf.writeUInt32LE(0x1f0000, modEntryOffset + 8); // SizeOfImage
  buf.writeUInt32LE(1680000000, modEntryOffset + 16); // TimeDateStamp
  const strRva = 350;
  buf.writeUInt32LE(strRva, modEntryOffset + 20); // ModuleNameRva

  // Write MINIDUMP_STRING at 350
  const modName = "C:\\Windows\\System32\\ntdll.dll";
  const strBytes = Buffer.from(modName, "utf16le");
  buf.writeUInt32LE(strBytes.length, strRva);
  strBytes.copy(buf, strRva + 4);

  return buf;
};

describe("MinidumpReader", () => {
  it("detects valid MDMP signature and rejects invalid files", () => {
    const valid = createMockMinidump();
    expect(isMinidump(valid)).toBe(true);

    const invalidVersion = createMockMinidump();
    invalidVersion.writeUInt16LE(0x1234, 4);
    expect(isMinidump(invalidVersion)).toBe(false);
    expect(parseMinidump(invalidVersion)).toBeNull();

    const invalid = Buffer.from("NOT_A_MINIDUMP_FILE");
    expect(isMinidump(invalid)).toBe(false);
  });

  it("parses system architecture, OS version and crash timestamp", () => {
    const valid = createMockMinidump();
    const report = parseMinidump(valid);
    expect(report).not.toBeNull();
    expect(report?.systemInfo?.architecture).toBe("x86-64 (AMD64)");
    expect(report?.systemInfo?.numberOfProcessors).toBe(8);
    expect(report?.systemInfo?.majorVersion).toBe(10);
    expect(report?.systemInfo?.buildNumber).toBe(19045);
    expect(report?.streamTypes).toContain(7); // SystemInfo
    expect(report?.streamTypes).toContain(6); // Exception
    expect(report?.streamTypes).toContain(4); // ModuleList
  });

  it("extracts crash exception code, address and thread ID", () => {
    const valid = createMockMinidump();
    const report = parseMinidump(valid);
    expect(report?.exception).toBeDefined();
    expect(report?.exception?.threadId).toBe(4242);
    expect(report?.exception?.codeName).toBe("STATUS_ACCESS_VIOLATION");
    expect(report?.exception?.codeHex).toBe("0xC0000005");
    expect(report?.exception?.address).toBe(0x7ffe12345678n);
  });

  it("parses loaded module list with base addresses and paths", () => {
    const valid = createMockMinidump();
    const report = parseMinidump(valid);
    expect(report?.modules.length).toBe(1);
    const mod = report?.modules[0];
    expect(mod?.name).toBe("C:\\Windows\\System32\\ntdll.dll");
    expect(mod?.baseAddress).toBe(0x7ffe00000000n);
    expect(mod?.size).toBe(0x1f0000);
  });

  it("ignores duplicate module list stream entries to prevent allocation exhaustion", () => {
    const valid = createMockMinidump();
    // Modify header to report 4 streams instead of 3
    valid.writeUInt32LE(4, 8);
    // Add 4th stream in directory pointing to the same ModuleListStream
    const streamDirRva = 32;
    valid.writeUInt32LE(4, streamDirRva + 36);
    valid.writeUInt32LE(120, streamDirRva + 40);
    valid.writeUInt32LE(160, streamDirRva + 44);

    const report = parseMinidump(valid);
    expect(report?.modules.length).toBe(1);
    expect(report?.streamTypes).toEqual([7, 6, 4, 4]);
    expect(report?.limitations).toEqual([]);
  });

  it("bounds excessive stream directory counts and records a limitation", () => {
    const streamCount = MAX_MINIDUMP_STREAMS + 5;
    const buf = Buffer.alloc(32 + streamCount * 12, 0);
    buf.writeUInt32LE(0x504d444d, 0);
    buf.writeUInt32LE(0x0000a793, 4);
    buf.writeUInt32LE(streamCount, 8);
    buf.writeUInt32LE(32, 12);

    const report = parseMinidump(buf);
    expect(report).not.toBeNull();
    expect(report?.streamTypes).toHaveLength(MAX_MINIDUMP_STREAMS);
    expect(report?.limitations[0]).toMatch(
      /only 1024 stream directory entries/,
    );
  });

  it("omits and reports module names that exceed MAX_MINIDUMP_STRING_BYTES instead of truncating them", () => {
    const base = createMockMinidump();
    const oversizedStrLen = MAX_MINIDUMP_STRING_BYTES + 2;
    const buf = Buffer.alloc(354 + oversizedStrLen, 0);
    base.copy(buf, 0, 0, 350);
    buf.writeUInt32LE(oversizedStrLen, 350);

    const report = parseMinidump(buf);
    expect(report).not.toBeNull();
    expect(report?.modules[0]?.name).toBeNull();
    expect(report?.limitations[0]).toMatch(
      /exceeded the 65536-byte string cap/,
    );
  });

  it("rejects odd-length UTF-16 MINIDUMP_STRING values and records a limitation", () => {
    const buf = createMockMinidump();
    // Module name MINIDUMP_STRING lives at RVA 350; set odd byte length 5
    buf.writeUInt32LE(5, 350);

    const report = parseMinidump(buf);
    expect(report).not.toBeNull();
    expect(report?.modules[0]?.name).toBeNull();
    expect(report?.limitations[0]).toMatch(/odd UTF-16 byte lengths/);
  });
});
