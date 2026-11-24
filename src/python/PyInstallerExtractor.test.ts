import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  extractPyInstallerEntries,
  findPyInstallerCookie,
  isPyInstallerBinary,
  parsePyInstallerArchive,
  parsePyzArchive,
  PYINSTALLER_MAGIC,
  PYZ_MAGIC,
} from "./PyInstallerExtractor.js";
import { isPythonBytecode } from "./PythonBytecode.js";

const marshalString = (text: string): Buffer => {
  const body = Buffer.from(text, "utf8");
  if (body.length <= 255 && body.every((byte) => byte < 0x80))
    return Buffer.concat([Buffer.from([0x7a, body.length]), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from([0x75]), length, body]);
};

const int32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(5);
  bytes[0] = 0x69;
  bytes.writeInt32LE(value, 1);
  return bytes;
};

const smallTuple = (items: readonly Buffer[]): Buffer =>
  Buffer.concat([Buffer.from([0x29, items.length]), ...items]);

const marshalPair = (
  name: string,
  typeCode: number,
  offset: number,
  length: number,
): Buffer =>
  smallTuple([
    marshalString(name),
    smallTuple([int32(typeCode), int32(offset), int32(length)]),
  ]);

const marshalList = (items: readonly Buffer[]): Buffer => {
  const count = Buffer.alloc(4);
  count.writeInt32LE(items.length, 0);
  return Buffer.concat([Buffer.from([0x5b]), count, ...items]);
};

const createMockPyzArchive = (): Buffer => {
  const pycMagic = Buffer.from([0x6f, 0x0d, 0x0d, 0x0a]); // 3439 (Python 3.10)
  const codeObject = Buffer.from("PRINT_HELLO_WORLD_CODE_OBJECT_12345");
  const compressedMod = zlib.deflateSync(codeObject);

  const modOffset = 12;
  const modLen = compressedMod.length;

  // Build standard PyInstaller PYZ table: [ (name, (typeCode, offset, length)) ]
  const tocBuf = marshalList([marshalPair("app.engine", 0, modOffset, modLen)]);

  const tocOffset = 12 + compressedMod.length;

  const header = Buffer.alloc(12);
  PYZ_MAGIC.copy(header, 0);
  pycMagic.copy(header, 4);
  header.writeUInt32BE(tocOffset, 8);

  return Buffer.concat([header, compressedMod, tocBuf]);
};

const createMockPyInstallerBinary = (): Buffer => {
  const bootloaderPrefix = Buffer.alloc(256, 0x90); // 256 bytes dummy executable
  const pyzData = createMockPyzArchive();

  const scriptCode = Buffer.from("MAIN_ENTRY_POINT_CODE_OBJECT_DATA");
  const compressedScript = zlib.deflateSync(scriptCode);

  const dllData = Buffer.from("MOCK_PYTHON_RUNTIME_DLL_PAYLOAD");

  // Pack data inside CArchive
  let carchiveData = Buffer.alloc(0);

  // 1. PYZ entry
  const pyzOffset = carchiveData.length;
  carchiveData = Buffer.concat([carchiveData, pyzData]);

  // 2. Script entry (compressed)
  const scriptOffset = carchiveData.length;
  carchiveData = Buffer.concat([carchiveData, compressedScript]);

  // 3. DLL entry (uncompressed)
  const dllOffset = carchiveData.length;
  carchiveData = Buffer.concat([carchiveData, dllData]);

  // Build CArchive TOC
  const createTocEntry = (options: {
    readonly name: string;
    readonly typeFlag: string;
    readonly pkgOffset: number;
    readonly compressedLen: number;
    readonly uncompressedLen: number;
    readonly compressionFlag: number;
  }): Buffer => {
    const {
      name,
      typeFlag,
      pkgOffset,
      compressedLen,
      uncompressedLen,
      compressionFlag,
    } = options;
    const nameBytes = Buffer.from(`${name}\0`, "utf8");
    const structLen = 18 + nameBytes.length;
    const entry = Buffer.alloc(structLen);
    entry.writeUInt32BE(structLen, 0);
    entry.writeUInt32BE(pkgOffset, 4);
    entry.writeUInt32BE(compressedLen, 8);
    entry.writeUInt32BE(uncompressedLen, 12);
    entry.writeUInt8(compressionFlag, 16);
    entry.writeUInt8(typeFlag.charCodeAt(0), 17);
    nameBytes.copy(entry, 18);
    return entry;
  };

  const tocEntries = Buffer.concat([
    createTocEntry({
      name: "PYZ-00.pyz",
      typeFlag: "z",
      pkgOffset: pyzOffset,
      compressedLen: pyzData.length,
      uncompressedLen: pyzData.length,
      compressionFlag: 0,
    }),
    createTocEntry({
      name: "main.py",
      typeFlag: "s",
      pkgOffset: scriptOffset,
      compressedLen: compressedScript.length,
      uncompressedLen: scriptCode.length,
      compressionFlag: 1,
    }),
    createTocEntry({
      name: "python310.dll",
      typeFlag: "b",
      pkgOffset: dllOffset,
      compressedLen: dllData.length,
      uncompressedLen: dllData.length,
      compressionFlag: 0,
    }),
  ]);

  const tocOffset = carchiveData.length;
  const tocLength = tocEntries.length;
  const pkgLength = carchiveData.length + tocLength + 88;

  // Build PyInstaller Cookie (88 bytes)
  const cookie = Buffer.alloc(88);
  PYINSTALLER_MAGIC.copy(cookie, 0);
  cookie.writeUInt32BE(pkgLength, 8);
  cookie.writeUInt32BE(tocOffset, 12);
  cookie.writeUInt32BE(tocLength, 16);
  cookie.writeInt32BE(310, 20); // Python 3.10
  Buffer.from("python310.dll\0", "ascii").copy(cookie, 24);

  return Buffer.concat([bootloaderPrefix, carchiveData, tocEntries, cookie]);
};

describe("PyInstallerExtractor - archive parsing", () => {
  it("detects PyInstaller cookie and extracts metadata", () => {
    const mockBinary = createMockPyInstallerBinary();
    expect(isPyInstallerBinary(mockBinary)).toBe(true);

    const cookie = findPyInstallerCookie(mockBinary);
    expect(cookie).not.toBeNull();
    expect(cookie?.pythonVersion).toBe(310);
    expect(cookie?.pythonLibName).toBe("python310.dll");
  });

  it("parses PYZ archive header and embedded modules", () => {
    const mockPyz = createMockPyzArchive();
    const pyz = parsePyzArchive(mockPyz);
    expect(pyz).not.toBeNull();
    expect(pyz?.pythonVersion).toBe("3.10");
    expect(pyz?.modules.length).toBe(1);
    expect(pyz?.modules[0]?.name).toBe("app.engine");
    expect(pyz?.modules[0]?.isPackage).toBe(false);
  });

  it("parses PyInstaller CArchive TOC structure", () => {
    const mockBinary = createMockPyInstallerBinary();
    const archive = parsePyInstallerArchive(mockBinary);
    expect(archive).not.toBeNull();
    expect(archive?.tocEntries.length).toBe(3);

    const names = archive?.tocEntries.map((e) => e.name);
    expect(names).toContain("PYZ-00.pyz");
    expect(names).toContain("main.py");
    expect(names).toContain("python310.dll");
    expect(archive?.embeddedPyz).toBeDefined();
    expect(archive?.embeddedPyz?.pythonVersion).toBe("3.10");
  });
});

describe("PyInstallerExtractor - entry extraction and safety limits", () => {
  it("extracts all entries and reconstructs valid .pyc bytecode files", () => {
    const mockBinary = createMockPyInstallerBinary();
    const extracted = extractPyInstallerEntries(mockBinary);
    expect(extracted.length).toBeGreaterThanOrEqual(3);

    // 1. Script entry point
    const script = extracted.find((f) => f.name === "main.py");
    expect(script).toBeDefined();
    expect(script?.kind).toBe("script");
    expect(script?.decompressed).toBe(true);
    expect(script?.bytecodeHeaderReconstructed).toBe(true);
    expect(script?.limitations[0]).toMatch(
      /bytecode header was reconstructed/i,
    );
    // Bytecode header must be reconstructed!
    expect(isPythonBytecode(script!.data)).toBe(true);

    // 2. Extracted PYZ module
    const pyzMod = extracted.find((f) => f.name === "app/engine.pyc");
    expect(pyzMod).toBeDefined();
    expect(pyzMod?.kind).toBe("module");
    expect(pyzMod?.decompressed).toBe(true);
    expect(pyzMod?.bytecodeHeaderReconstructed).toBe(true);
    expect(pyzMod?.limitations[0]).toMatch(
      /bytecode header was reconstructed/i,
    );
    expect(isPythonBytecode(pyzMod!.data)).toBe(true);
    expect(pyzMod?.pythonVersion).toBe("3.10");

    // 3. Binary DLL file
    const dll = extracted.find((f) => f.name === "python310.dll");
    expect(dll).toBeDefined();
    expect(dll?.kind).toBe("binary");
    expect(dll?.data.toString("utf8")).toBe("MOCK_PYTHON_RUNTIME_DLL_PAYLOAD");
  });

  it("handles tiny PYZ with huge tuple count gracefully without memory exhaustion", () => {
    // 17 bytes: valid header, tocOffset = 12, bytes: 28 ff ff ff ff (tuple count = 4294967295)
    const header = Buffer.alloc(12);
    PYZ_MAGIC.copy(header, 0);
    Buffer.from([0x6f, 0x0d, 0x0d, 0x0a]).copy(header, 4);
    header.writeUInt32BE(12, 8);
    const malformed = Buffer.concat([
      header,
      Buffer.from([0x28, 0xff, 0xff, 0xff, 0xff]),
    ]);
    const pyz = parsePyzArchive(malformed);
    expect(pyz).not.toBeNull();
    expect(pyz?.modules).toEqual([]);
    expect(pyz?.limitations?.[0]).toMatch(/could not be parsed/i);
  });

  it("bounds decompression when uncompressedLength is smaller than expanded output", () => {
    const raw = Buffer.alloc(1024, 0x41);
    const compressed = zlib.deflateSync(raw);

    // Build binary with declared uncompressedLen = 10, but actual = 1024
    const cookie = Buffer.alloc(88);
    PYINSTALLER_MAGIC.copy(cookie, 0);

    const nameBytes = Buffer.from("bomb.py\0", "utf8");
    const structLen = 18 + nameBytes.length;
    const tocEntry = Buffer.alloc(structLen);
    tocEntry.writeUInt32BE(structLen, 0);
    tocEntry.writeUInt32BE(0, 4); // pkgOffset = 0
    tocEntry.writeUInt32BE(compressed.length, 8);
    tocEntry.writeUInt32BE(10, 12); // uncompressedLen = 10 (exceeded by 1024)
    tocEntry.writeUInt8(1, 16); // compressed
    tocEntry.writeUInt8("s".charCodeAt(0), 17);
    nameBytes.copy(tocEntry, 18);

    const carchiveData = compressed;
    const tocOffset = carchiveData.length;
    const tocLength = tocEntry.length;
    const pkgLength = carchiveData.length + tocLength + 88;

    cookie.writeUInt32BE(pkgLength, 8);
    cookie.writeUInt32BE(tocOffset, 12);
    cookie.writeUInt32BE(tocLength, 16);
    cookie.writeInt32BE(310, 20);

    const binary = Buffer.concat([carchiveData, tocEntry, cookie]);
    const extracted = extractPyInstallerEntries(binary);
    expect(extracted.length).toBe(1);
    expect(extracted[0]?.decompressed).toBe(false);
    expect(extracted[0]?.limitations[0]).toContain("Decompression error");
  });

  it("rejects non-string names in PYZ table to prevent expansion bombs", () => {
    const header = Buffer.alloc(12);
    PYZ_MAGIC.copy(header, 0);
    Buffer.from([0x6f, 0x0d, 0x0d, 0x0a]).copy(header, 4);
    header.writeUInt32BE(12, 8);

    // Marshal table containing a tuple with a nested list instead of string name:
    // [ ( [1, 2], (0, 12, 0) ) ]
    const table = Buffer.from([
      0x5b,
      0x01,
      0x00,
      0x00,
      0x00, // list of 1 element
      0x28,
      0x02,
      0x00,
      0x00,
      0x00, // tuple of 2 elements:
      0x5b,
      0x00,
      0x00,
      0x00,
      0x00, // element 0: empty list (not string!)
      0x28,
      0x03,
      0x00,
      0x00,
      0x00, // element 1: tuple of 3 integers:
      0xe9,
      0x00,
      0x00,
      0x00,
      0x00, // 0 (typeCode)
      0xe9,
      0x0c,
      0x00,
      0x00,
      0x00, // 12 (offset)
      0xe9,
      0x00,
      0x00,
      0x00,
      0x00, // 0 (length)
    ]);
    const pyz = parsePyzArchive(Buffer.concat([header, table]));
    expect(pyz).not.toBeNull();
    expect(pyz?.modules).toEqual([]);
    expect(pyz?.limitations?.[0]).toMatch(/PYZ table entry/i);
  });

  it("charges failed or corrupt inflations against remaining budget", () => {
    // Construct mock binary with corrupt compressed entry
    const corruptData = Buffer.from("not_valid_deflate_data");
    const nameBytes = Buffer.from("corrupt.py\0", "utf8");
    const structLen = 18 + nameBytes.length;
    const entry = Buffer.alloc(structLen);
    entry.writeUInt32BE(structLen, 0);
    entry.writeUInt32BE(0, 4); // offset 0
    entry.writeUInt32BE(corruptData.length, 8);
    entry.writeUInt32BE(100, 12);
    entry.writeUInt8(1, 16); // compressionFlag = 1 (zlib)
    entry.writeUInt8("s".charCodeAt(0), 17);
    nameBytes.copy(entry, 18);

    const carchiveData = corruptData;
    const tocEntries = entry;
    const tocOffset = carchiveData.length;
    const tocLength = tocEntries.length;
    const pkgLength = carchiveData.length + tocLength + 88;

    const cookie = Buffer.alloc(88);
    PYINSTALLER_MAGIC.copy(cookie, 0);
    cookie.writeUInt32BE(pkgLength, 8);
    cookie.writeUInt32BE(tocOffset, 12);
    cookie.writeUInt32BE(tocLength, 16);
    cookie.writeInt32BE(310, 20);

    const mockBinary = Buffer.concat([carchiveData, tocEntries, cookie]);
    const extracted = extractPyInstallerEntries(mockBinary);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]!.decompressed).toBe(false);
    expect(extracted[0]!.limitations[0]).toMatch(/Decompression error/);
  });
});

describe("PyInstallerExtractor - CArchive bounds and declarations", () => {
  it("rejects TOC entries pointing into the table or cookie and preserves valid declarations", () => {
    const createTocEntry = (
      name: string,
      typeFlag: string,
      pkgOffset: number,
      len: number,
    ): Buffer => {
      const nameBytes = Buffer.from(`${name}\0`, "utf8");
      const structLen = 18 + nameBytes.length;
      const entry = Buffer.alloc(structLen);
      entry.writeUInt32BE(structLen, 0);
      entry.writeUInt32BE(pkgOffset, 4);
      entry.writeUInt32BE(len, 8);
      entry.writeUInt32BE(len, 12);
      entry.writeUInt8(0, 16);
      entry.writeUInt8(typeFlag.charCodeAt(0), 17);
      nameBytes.copy(entry, 18);
      return entry;
    };

    const buildArchive = (payload: Buffer, tocEntries: Buffer): Buffer => {
      const tocOffset = payload.length;
      const tocLength = tocEntries.length;
      const pkgLength = payload.length + tocLength + 88;
      const cookie = Buffer.alloc(88);
      PYINSTALLER_MAGIC.copy(cookie, 0);
      cookie.writeUInt32BE(pkgLength, 8);
      cookie.writeUInt32BE(tocOffset, 12);
      cookie.writeUInt32BE(tocLength, 16);
      cookie.writeInt32BE(310, 20);
      return Buffer.concat([payload, tocEntries, cookie]);
    };

    const payload = Buffer.from("REAL_DATA");

    // Out-of-bounds member pointing into TOC must reject the archive instead of silently omitting it
    const badBinary = buildArchive(
      payload,
      createTocEntry("table_bytes.bin", "x", payload.length, 4),
    );
    expect(parsePyInstallerArchive(badBinary)).toBeNull();
    expect(extractPyInstallerEntries(badBinary)).toEqual([]);

    // Truncated TOC record after a valid entry must reject the archive instead of returning preceding entries
    const validEntry = createTocEntry("ok.bin", "x", 0, payload.length);
    const truncatedSecondRecord = Buffer.alloc(18);
    truncatedSecondRecord.writeUInt32BE(64, 0); // declares 64 bytes past TOC end
    const truncatedTocBinary = buildArchive(
      payload,
      Buffer.concat([validEntry, truncatedSecondRecord]),
    );
    expect(parsePyInstallerArchive(truncatedTocBinary)).toBeNull();

    // Valid archive with runtime option ('o') and multipackage dependency ('d') preserves declarations
    const declBinary = buildArchive(
      payload,
      Buffer.concat([
        createTocEntry("pyi-runtime-tmpdir", "o", 0, 0),
        createTocEntry("ext_pkg:lib.dll", "d", 0, 0),
      ]),
    );
    const extracted = extractPyInstallerEntries(declBinary);

    const opt = extracted.find((e) => e.name === "pyi-runtime-tmpdir");
    expect(opt?.kind).toBe("metadata");
    expect(opt?.decompressed).toBe(false);

    const dep = extracted.find((e) => e.name === "ext_pkg:lib.dll");
    expect(dep?.kind).toBe("binary");
    expect(dep?.decompressed).toBe(false);
    expect(dep?.limitations[0]).toMatch(/unresolved/);
  });

  it("rejects compressed CArchive entries that expand to fewer bytes than declared", () => {
    const raw = Buffer.from("short_payload");
    const compressed = zlib.deflateSync(raw);

    const cookie = Buffer.alloc(88);
    PYINSTALLER_MAGIC.copy(cookie, 0);

    const nameBytes = Buffer.from("short.py\0", "utf8");
    const structLen = 18 + nameBytes.length;
    const tocEntry = Buffer.alloc(structLen);
    tocEntry.writeUInt32BE(structLen, 0);
    tocEntry.writeUInt32BE(0, 4);
    tocEntry.writeUInt32BE(compressed.length, 8);
    tocEntry.writeUInt32BE(raw.length + 50, 12); // declared larger than actual
    tocEntry.writeUInt8(1, 16);
    tocEntry.writeUInt8("s".charCodeAt(0), 17);
    nameBytes.copy(tocEntry, 18);

    const carchiveData = compressed;
    const tocOffset = carchiveData.length;
    const tocLength = tocEntry.length;
    const pkgLength = carchiveData.length + tocLength + 88;

    cookie.writeUInt32BE(pkgLength, 8);
    cookie.writeUInt32BE(tocOffset, 12);
    cookie.writeUInt32BE(tocLength, 16);
    cookie.writeInt32BE(310, 20);

    const binary = Buffer.concat([carchiveData, tocEntry, cookie]);
    const extracted = extractPyInstallerEntries(binary);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]?.decompressed).toBe(false);
    expect(extracted[0]?.limitations[0]).toMatch(
      /contradicts declared uncompressed length/,
    );
  });

  it("rejects in-bounds CArchive tables that exceed MAX_TOC_BYTES or MAX_TOC_ENTRIES", () => {
    const overBytesLen = 32 * 1024 * 1024 + 1;
    const overBytesBuf = Buffer.alloc(overBytesLen + 88);
    const cookieOffset = overBytesLen;
    PYINSTALLER_MAGIC.copy(overBytesBuf, cookieOffset);
    overBytesBuf.writeUInt32BE(overBytesBuf.length, cookieOffset + 8); // pkgLength fits in buffer
    overBytesBuf.writeUInt32BE(0, cookieOffset + 12); // tocOffset = 0
    overBytesBuf.writeUInt32BE(overBytesLen, cookieOffset + 16); // tocLength > MAX_TOC_BYTES
    overBytesBuf.writeInt32BE(310, cookieOffset + 20);
    expect(parsePyInstallerArchive(overBytesBuf)).toBeNull();

    // 100,001 valid named records of 20 bytes each (fits well within MAX_TOC_BYTES and buffer)
    const entryCount = 100_001;
    const recLen = 20;
    const tocLen = entryCount * recLen;
    const overEntriesBuf = Buffer.alloc(tocLen + 88);
    for (let i = 0; i < entryCount; i += 1) {
      const off = i * recLen;
      overEntriesBuf.writeUInt32BE(recLen, off);
      overEntriesBuf.writeUInt8("o".charCodeAt(0), off + 17);
      overEntriesBuf.writeUInt8("a".charCodeAt(0), off + 18);
      overEntriesBuf.writeUInt8(0, off + 19);
    }
    PYINSTALLER_MAGIC.copy(overEntriesBuf, tocLen);
    overEntriesBuf.writeUInt32BE(overEntriesBuf.length, tocLen + 8);
    overEntriesBuf.writeUInt32BE(0, tocLen + 12);
    overEntriesBuf.writeUInt32BE(tocLen, tocLen + 16);
    overEntriesBuf.writeInt32BE(310, tocLen + 20);
    expect(parsePyInstallerArchive(overEntriesBuf)).toBeNull();
  });

  it("reports a limitation when a PYZ table exceeds MAX_PYZ_TABLE_BYTES", () => {
    const oversizedTableLen = 16 * 1024 * 1024 + 1;
    const pyzBuf = Buffer.alloc(12 + oversizedTableLen);
    PYZ_MAGIC.copy(pyzBuf, 0);
    Buffer.from([0x6f, 0x0d, 0x0d, 0x0a]).copy(pyzBuf, 4);
    pyzBuf.writeUInt32BE(12, 8);
    const parsed = parsePyzArchive(pyzBuf);
    expect(parsed).not.toBeNull();
    expect(parsed?.modules).toEqual([]);
    expect(parsed?.limitations?.[0]).toMatch(
      /exceeds maximum in-memory table budget/,
    );
  });

  it("reports omitted PYZ modules on the PYZ entry when total expansion budget is exhausted mid-PYZ", () => {
    // Build a PyInstaller binary whose sole CArchive entry is a PYZ with two modules.
    // The first module succeeds and consumes the remaining expansion budget, forcing the second to be omitted.
    const mod1Payload = Buffer.alloc(1024, 0x41);
    const compressedMod1 = zlib.deflateSync(mod1Payload);
    const compressedMod2 = zlib.deflateSync(Buffer.from("SECOND_MODULE_CODE"));
    const mod1Offset = 12;
    const mod2Offset = mod1Offset + compressedMod1.length;
    const tocBuf = marshalList([
      marshalPair("app.first", 0, mod1Offset, compressedMod1.length),
      marshalPair("app.skipped", 0, mod2Offset, compressedMod2.length),
    ]);
    const pyzHeader = Buffer.alloc(12);
    PYZ_MAGIC.copy(pyzHeader, 0);
    Buffer.from([0x6f, 0x0d, 0x0d, 0x0a]).copy(pyzHeader, 4);
    pyzHeader.writeUInt32BE(mod2Offset + compressedMod2.length, 8);
    const pyzData = Buffer.concat([
      pyzHeader,
      compressedMod1,
      compressedMod2,
      tocBuf,
    ]);

    const nameBytes = Buffer.from("PYZ-00.pyz\0", "utf8");
    const structLen = 18 + nameBytes.length;
    const tocEntry = Buffer.alloc(structLen);
    tocEntry.writeUInt32BE(structLen, 0);
    tocEntry.writeUInt32BE(0, 4);
    tocEntry.writeUInt32BE(pyzData.length, 8);
    tocEntry.writeUInt32BE(pyzData.length, 12);
    tocEntry.writeUInt8(0, 16);
    tocEntry.writeUInt8("z".charCodeAt(0), 17);
    nameBytes.copy(tocEntry, 18);

    const cookie = Buffer.alloc(88);
    PYINSTALLER_MAGIC.copy(cookie, 0);
    cookie.writeUInt32BE(pyzData.length + tocEntry.length + 88, 8);
    cookie.writeUInt32BE(pyzData.length, 12);
    cookie.writeUInt32BE(tocEntry.length, 16);
    cookie.writeInt32BE(310, 20);

    const binary = Buffer.concat([pyzData, tocEntry, cookie]);
    // Budget covers the PYZ container plus the first decompressed module (with 16-byte reconstructed header),
    // leaving 0 bytes for the second module.
    const extracted = extractPyInstallerEntries(binary, {
      maxExpandedBytes: pyzData.length + mod1Payload.length + 16,
    });
    const pyzResult = extracted.find((entry) => entry.kind === "pyz");
    expect(pyzResult).toBeDefined();
    expect(pyzResult?.limitations.join(" ")).toMatch(
      /1 PYZ module\(s\) were omitted/,
    );
    expect(extracted.some((entry) => entry.name === "app/first.pyc")).toBe(
      true,
    );
    expect(extracted.some((entry) => entry.name === "app/skipped.pyc")).toBe(
      false,
    );

    // A zero-byte caller allowance must also prevent pre-parsing/inflating the embedded PYZ
    const zeroBudget = extractPyInstallerEntries(binary, {
      maxExpandedBytes: 0,
    });
    expect(zeroBudget).toHaveLength(1);
    expect(zeroBudget[0]?.decompressed).toBe(false);
    expect(zeroBudget[0]?.data.length).toBe(0);
    expect(zeroBudget[0]?.limitations[0]).toMatch(
      /expansion budget of 0 bytes/,
    );
  });
});

describe("PyInstallerExtractor - CArchive cookie layout", () => {
  it("determines CArchive v2.0 24-byte cookie layout structurally when followed by a trailing signature overlay", () => {
    const bootloader = Buffer.alloc(64, 0x90);
    const scriptPayload = Buffer.from("LEGACY_V20_SCRIPT_CODE_OBJECT");
    const nameBytes = Buffer.from("legacy_main.py\0", "utf8");
    const tocLen = 18 + nameBytes.length;
    const tocEntry = Buffer.alloc(tocLen);
    tocEntry.writeUInt32BE(tocLen, 0);
    tocEntry.writeUInt32BE(0, 4);
    tocEntry.writeUInt32BE(scriptPayload.length, 8);
    tocEntry.writeUInt32BE(scriptPayload.length, 12);
    tocEntry.writeUInt8(0, 16); // uncompressed
    tocEntry.writeUInt8("s".charCodeAt(0), 17);
    nameBytes.copy(tocEntry, 18);

    const tocOffset = scriptPayload.length;
    const pkgLength = scriptPayload.length + tocLen + 24;
    const cookieV20 = Buffer.alloc(24);
    PYINSTALLER_MAGIC.copy(cookieV20, 0);
    cookieV20.writeUInt32BE(pkgLength, 8);
    cookieV20.writeUInt32BE(tocOffset, 12);
    cookieV20.writeUInt32BE(tocLen, 16);
    cookieV20.writeInt32BE(27, 20); // Python 2.7

    // Trailing 128-byte code signature overlay (>= 64 bytes past the 24-byte cookie)
    const signatureOverlay = Buffer.alloc(128, 0xfe);

    const signedLegacyBinary = Buffer.concat([
      bootloader,
      scriptPayload,
      tocEntry,
      cookieV20,
      signatureOverlay,
    ]);

    const cookie = findPyInstallerCookie(signedLegacyBinary);
    expect(cookie?.layout).toBe("2.0");
    expect(cookie?.pythonLibName).toBe("");

    const archive = parsePyInstallerArchive(signedLegacyBinary);
    expect(archive).not.toBeNull();
    expect(archive?.carchiveOffset).toBe(bootloader.length);
    expect(archive?.tocEntries).toHaveLength(1);
    expect(archive?.tocEntries[0]?.name).toBe("legacy_main.py");
  });
});
