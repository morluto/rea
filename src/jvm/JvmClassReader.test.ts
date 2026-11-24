import { describe, expect, it } from "vitest";
import {
  decodeAccessFlags,
  decodeModifiedUtf8,
  parseJvmClass,
  resolveJavaRelease,
} from "./JvmClassReader.js";

const createMockClassFile = (): Uint8Array => {
  const parts: Uint8Array[] = [];

  const u1 = (n: number) => parts.push(new Uint8Array([n & 0xff]));
  const u2 = (n: number) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, false);
    parts.push(b);
  };
  const u4 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    parts.push(b);
  };
  const utf8 = (str: string) => {
    const raw = new TextEncoder().encode(str);
    u1(1); // tag UTF8
    u2(raw.length);
    parts.push(raw);
  };
  const classRef = (nameIndex: number) => {
    u1(7); // tag Class
    u2(nameIndex);
  };

  // Header
  u4(0xcafebabe); // magic
  u2(0); // minor
  u2(61); // major (Java 17)

  // Constant pool count = 12 (entries 1 to 11)
  u2(12);
  utf8("com/example/UserService"); // 1
  classRef(1); // 2
  utf8("java/lang/Object"); // 3
  classRef(3); // 4
  utf8("userId"); // 5
  utf8("Ljava/lang/String;"); // 6
  utf8("getUserId"); // 7
  utf8("()Ljava/lang/String;"); // 8
  utf8("Code"); // 9
  utf8("SourceFile"); // 10
  utf8("UserService.java"); // 11

  // Class declaration
  u2(0x0021); // public super
  u2(2); // this_class = 2 ("com/example/UserService")
  u2(4); // super_class = 4 ("java/lang/Object")
  u2(0); // 0 interfaces

  // Fields (1 field: private userId)
  u2(1); // 1 field
  u2(0x0002); // private
  u2(5); // name: "userId"
  u2(6); // descriptor: "Ljava/lang/String;"
  u2(0); // 0 attributes

  // Methods (1 method: public getUserId() with Code attribute)
  u2(1); // 1 method
  u2(0x0001); // public
  u2(7); // name: "getUserId"
  u2(8); // descriptor: "()Ljava/lang/String;"
  u2(1); // 1 attribute
  u2(9); // attr name: "Code"
  u4(16); // attr length = 16 (max_stack + max_locals + code_length + 4 code + exc_count + attr_count)
  u2(1); // max_stack
  u2(1); // max_locals
  u4(4); // code_length = 4 bytes
  parts.push(new Uint8Array([0x2a, 0xb4, 0x00, 0xb0])); // aload_0, getfield, return
  u2(0); // exception_table_length = 0
  u2(0); // attributes_count = 0

  // Class attributes (SourceFile)
  u2(1); // 1 attribute
  u2(10); // attr name: "SourceFile"
  u4(2); // length = 2
  u2(11); // sourcefile index = 11 ("UserService.java")

  // Combine into single buffer
  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
};

describe("JvmClassReader", () => {
  it("resolves standard Java releases from major class versions", () => {
    expect(resolveJavaRelease(52)).toBe("Java 8");
    expect(resolveJavaRelease(55)).toBe("Java 11");
    expect(resolveJavaRelease(61)).toBe("Java 17 (LTS)");
    expect(resolveJavaRelease(65)).toBe("Java 21 (LTS)");
  });

  it("rejects non-class files", () => {
    const invalid = new Uint8Array([1, 2, 3, 4]);
    expect(parseJvmClass(invalid)).toBeNull();
  });

  it("parses Java class declaration, version and superclass", () => {
    const classBytes = createMockClassFile();
    const report = parseJvmClass(classBytes);
    expect(report).not.toBeNull();
    expect(report?.majorVersion).toBe(61);
    expect(report?.javaVersion).toBe("Java 17 (LTS)");
    expect(report?.thisClass).toBe("com/example/UserService");
    expect(report?.superClass).toBe("java/lang/Object");
    expect(report?.accessFlags).toContain("public");
    expect(report?.accessFlags).toContain("super");
    expect(report?.sourceFile).toBe("UserService.java");
  });

  it("parses fields, methods, descriptors and code lengths", () => {
    const classBytes = createMockClassFile();
    const report = parseJvmClass(classBytes);
    expect(report).not.toBeNull();

    // Fields
    expect(report?.fields.length).toBe(1);
    expect(report?.fields[0]?.name).toBe("userId");
    expect(report?.fields[0]?.descriptor).toBe("Ljava/lang/String;");
    expect(report?.fields[0]?.accessFlags).toContain("private");

    // Methods
    expect(report?.methods.length).toBe(1);
    const method = report?.methods[0];
    expect(method?.name).toBe("getUserId");
    expect(method?.descriptor).toBe("()Ljava/lang/String;");
    expect(method?.accessFlags).toContain("public");
    expect(method?.codeLength).toBe(4);
  });

  it("decodes Modified UTF-8 correctly including embedded null and surrogate pairs", () => {
    // Embedded null: 0xC0 0x80
    const nullBytes = new Uint8Array([0x61, 0xc0, 0x80, 0x62]);
    expect(decodeModifiedUtf8(nullBytes)).toBe("a\0b");

    // Standard 2-byte: U+00E9 (é) -> 0xC3 0xA9
    const eAcute = new Uint8Array([0xc3, 0xa9]);
    expect(decodeModifiedUtf8(eAcute)).toBe("é");

    // Supplementary character outside BMP: U+10348 (𐍈)
    // UTF-16: 0xD800 0xDF48
    // MUTF-8: 0xED 0xA0 0x80 (for 0xD800) followed by 0xED 0xBD 0x88 (for 0xDF48)
    const gothicChar = new Uint8Array([0xed, 0xa0, 0x80, 0xed, 0xbd, 0x88]);
    expect(decodeModifiedUtf8(gothicChar)).toBe("𐍈");
  });

  it("decodes method and field access flags properly", () => {
    // synchronized (0x0020) + native (0x0100) + strictfp (0x0800)
    const methodFlags = decodeAccessFlags(0x0020 | 0x0100 | 0x0800, "method");
    expect(methodFlags).toContain("synchronized");
    expect(methodFlags).toContain("native");
    expect(methodFlags).toContain("strictfp");

    // volatile (0x0040) + transient (0x0080)
    const fieldFlags = decodeAccessFlags(0x0040 | 0x0080, "field");
    expect(fieldFlags).toContain("volatile");
    expect(fieldFlags).toContain("transient");
  });

  it("rejects classes with unsupported constant-pool tags", () => {
    // 25-byte buffer with valid magic and unknown tag 99
    const b = new Uint8Array(25);
    const view = new DataView(b.buffer);
    view.setUint32(0, 0xcafebabe, false);
    view.setUint16(4, 0, false); // minor
    view.setUint16(6, 61, false); // major
    view.setUint16(8, 2, false); // cpCount = 2
    b[10] = 99; // unknown tag
    expect(parseJvmClass(b)).toBeNull();
  });

  it("rejects empty constant pools and invalid major 56+ minor versions", () => {
    // 24-byte CAFEBABE buffer with cpCount = 0 and thisClass = 0
    const emptyPool = new Uint8Array(24);
    const emptyView = new DataView(emptyPool.buffer);
    emptyView.setUint32(0, 0xcafebabe, false);
    emptyView.setUint16(4, 0, false);
    emptyView.setUint16(6, 61, false);
    emptyView.setUint16(8, 0, false); // cpCount = 0 (invalid per JVMS)
    expect(parseJvmClass(emptyPool)).toBeNull();

    // JVMS §4.1: major >= 56 permits only minor 0 or 65535
    const invalidJava12 = new Uint8Array(createMockClassFile());
    new DataView(invalidJava12.buffer).setUint16(4, 3, false); // minor = 3
    new DataView(invalidJava12.buffer).setUint16(6, 56, false); // major = 56
    expect(parseJvmClass(invalidJava12)).toBeNull();

    // Java 17 preview (61.65535), Java 11 (55.1), and Java 1.1 (45.3) remain valid per JVMS §4.1
    const previewJava17 = new Uint8Array(createMockClassFile());
    new DataView(previewJava17.buffer).setUint16(4, 0xffff, false);
    new DataView(previewJava17.buffer).setUint16(6, 61, false);
    expect(parseJvmClass(previewJava17)?.minorVersion).toBe(0xffff);

    const java11Minor = new Uint8Array(createMockClassFile());
    new DataView(java11Minor.buffer).setUint16(4, 1, false);
    new DataView(java11Minor.buffer).setUint16(6, 55, false);
    expect(parseJvmClass(java11Minor)?.majorVersion).toBe(55);

    const legacyJava11 = new Uint8Array(createMockClassFile());
    new DataView(legacyJava11.buffer).setUint16(4, 3, false);
    new DataView(legacyJava11.buffer).setUint16(6, 45, false);
    expect(parseJvmClass(legacyJava11)?.majorVersion).toBe(45);
  });

  it("rejects malformed Code attributes whose code_length or tables exceed the attribute extent", () => {
    // Build a class whose Code attribute declares attrLen = 8 and code_length = 4 (missing code + tables)
    const valid = createMockClassFile();
    // Locate the Code attribute length (16) and replace Code attribute with 8-byte truncated one
    const view = new DataView(valid.buffer, valid.byteOffset, valid.byteLength);
    let codeAttrLenOffset = -1;
    for (let i = 0; i <= valid.length - 16; i += 1) {
      if (
        view.getUint16(i, false) === 9 &&
        view.getUint32(i + 2, false) === 16
      ) {
        codeAttrLenOffset = i + 2;
        break;
      }
    }
    expect(codeAttrLenOffset).toBeGreaterThan(0);

    // 1. attrLen = 8, code_length = 4 (truncated Code_attribute)
    const truncatedCodeAttr = new Uint8Array([
      ...valid.subarray(0, codeAttrLenOffset),
      0,
      0,
      0,
      8, // attrLen = 8
      ...valid.subarray(codeAttrLenOffset + 4, codeAttrLenOffset + 12), // max_stack, max_locals, code_length=4
      ...valid.subarray(codeAttrLenOffset + 4 + 16), // class attributes
    ]);
    expect(parseJvmClass(truncatedCodeAttr)).toBeNull();

    // 2. attrLen = 16, code_length = 100 (exceeds attribute extent)
    const oversizedCodeLen = new Uint8Array(valid);
    new DataView(oversizedCodeLen.buffer).setUint32(
      codeAttrLenOffset + 8,
      100,
      false,
    );
    expect(parseJvmClass(oversizedCodeLen)).toBeNull();

    // 3. attrLen = 16, exception_table_length = 5 (exceeds remaining bytes)
    const oversizedExceptionTable = new Uint8Array(valid);
    new DataView(oversizedExceptionTable.buffer).setUint16(
      codeAttrLenOffset + 16,
      5,
      false,
    );
    expect(parseJvmClass(oversizedExceptionTable)).toBeNull();
  });
});
